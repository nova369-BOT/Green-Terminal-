/**
 * GREEN TERMINAL — bootstrap + orchestration.
 *
 * One rAF-coalesced paint per animation frame, driven by three inputs:
 *   feed events (ticks, closed bars, status)  →  state
 *   state changes                             →  chart + panels
 *   user intent (clicks, keys, form input)     →  store / engine / broker
 * The chart is the only thing that redraws at tick frequency; panels redraw on the
 * quarter-second budget below so the DOM never becomes the bottleneck of the data path.
 */
import { state, set, subscribe, toast, emit } from '../modules/store.js';
import { startFeed, on, clock, quotes, bars, instrumentFor, universe } from '../modules/feed.js';
import { buildIndicatorSet } from '../modules/indicators.js';
import { createChart } from '../ui/chart.js';
import { createTopbar } from '../ui/topbar.js';
import { createWatchlist } from '../ui/watchlist.js';
import { createDock } from '../ui/dock.js';
import { createConsole } from '../ui/console.js';
import { engine, startEngine, restore, setAllHalted, log as engineLog } from '../modules/engine.js';
import { account, engageKillSwitch, releaseKillSwitch, resetAccount } from '../modules/broker.js';
import { fmtPrice, fmtPct, signClass } from '../modules/fmt.js';
import { TIMEFRAMES } from '../modules/sim.js';
import { engineSnapshot } from '../modules/engine.js';

const bootLog = document.getElementById('boot-log');
const bootEl = document.getElementById('boot');
const appEl = document.getElementById('app');
const lines = [];
function boot(text, ms = 0) {
  lines.push(text);
  if (bootLog) bootLog.textContent = lines.join('\n');
  return new Promise((r) => setTimeout(r, ms));
}

const cfg = {
  provider: new URLSearchParams(location.search).get('provider') === 'rest' ? 'rest' : 'sim',
  speed: Number(new URLSearchParams(location.search).get('speed')) || 1,
};

await boot('green-terminal v0.1.0 · zero-dependency build', 40);
await boot(`data provider: ${cfg.provider}  (rest adapter: src/modules/feed.js → startFeed({provider:'rest'}))`, 40);
await boot(`instruments: ${universe().length}  ·  timeframes: ${TIMEFRAMES.map((t) => t.id).join(' ')}`, 40);
await boot('risk overlay: fee 4bp · slip 2.5bp · daily stop 3.5% · kill switch armed', 30);
await boot('restoring saved strategies…', 30);
state.startedAt = Date.now();
startEngine();
const restored = restore();
await boot(`${restored.length ? `restored ${restored.length} strategies` : 'no saved strategies — library presets available'}`, 20);
await boot('mounting terminal…', 20);

/* ------------------------------------------------------------------ panels */

const topbar = createTopbar(document.getElementById('topbar'), {
  onKill: (on) => {
    if (on) {
      engageKillSwitch('topbar');
      setAllHalted(true);
      toast('kill switch engaged — automation halted, positions flattened', 'bad', 6000);
    } else {
      releaseKillSwitch();
      setAllHalted(false);
      toast('trading resumed', 'ok');
    }
    schedule();
  },
  onSpeed: (s) => {
    clock.setSpeed(s);
    toast(`clock: ${s === 1 ? 'realtime' : `${s === 60 ? '1 simulated minute' : '10 simulated minutes'} per second`}`, 'info');
    schedule();
  },
  onResetDay: () => {
    resetAccount(account.startingEquity);
    schedule();
  },
});

const watchlist = createWatchlist(document.getElementById('watchlist'));
const consolePanel = createConsole(document.getElementById('console'));
const dock = createDock(document.getElementById('dock'));
const chartHost = document.getElementById('chart');
const chart = createChart(chartHost);

/* ------------------------------------------------------------------ statusbar */

const statusbar = document.getElementById('statusbar');
function renderStatusbar() {
  const q = state.quote;
  const snap = engineSnapshot();
  statusbar.innerHTML = `
    <span class="sb sb--kbd">shortcuts <b>1-6</b> timeframe · <b>[ ]</b> pan · <b>+ −</b> zoom · <b>R</b> reset · <b>K</b> kill · <b>← →</b> symbol · <b>/</b> search</span>
    <span class="sb__spacer"></span>
    <span class="sb">bars <b>${state.barCount ?? '—'}</b></span>
    <span class="sb">evals <b>${snap.evaluations}</b></span>
    <span class="sb">signals <b>${snap.signals}</b></span>
    <span class="sb ${snap.rejections ? 'down' : ''}">refused <b>${snap.rejections}</b></span>
    <span class="sb">clock <b>${clock.speed === 1 ? '1×' : clock.speed === 60 ? '60× (1m/s)' : `${clock.speed / 60}m/s`}</b></span>
    <span class="sb ${q ? signClass(q.changePct) : ''}">${state.symbol} <b>${q ? fmtPrice(q.last, state.meta?.tick) : ''}</b> ${q ? fmtPct(q.changePct) : ''}</span>
    <span class="sb sb--note">paper environment · simulated market data · nothing here places a real order</span>`;
}

/* ------------------------------------------------------------------ chart data */

let cache = { key: '', dataset: null, indicators: null };

function overlaySpecs() {
  const o = state.overlays;
  const specs = [];
  if (o.ema20) specs.push({ name: 'ema', args: [20] });
  if (o.ema50) specs.push({ name: 'ema', args: [50] });
  if (o.ema200) specs.push({ name: 'ema', args: [200] });
  if (o.vwap) specs.push({ name: 'vwap', args: [] });
  if (o.bb) specs.push({ name: 'bb', args: [20, 2] });
  if (o.donchian) specs.push({ name: 'donchian', args: [20] });
  if (state.panes.rsi) specs.push({ name: 'rsi', args: [14] });
  if (state.panes.macd) specs.push({ name: 'macd', args: [12, 26, 9] });
  for (const { strategy } of engine.deployed.values()) {
    if (strategy.symbol !== state.symbol) continue;
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.kind === 'ind') specs.push({ name: n.name, args: n.args ?? [] });
      (n.args ?? []).forEach(walk);
      for (const slot of ['left', 'right']) {
        const x = n[slot];
        if (!x) continue;
        if (Array.isArray(x)) x.forEach(walk);
        else walk(x);
      }
    };
    walk(strategy.entry);
    walk(strategy.exit);
  }
  const seen = new Set();
  return specs.filter((s) => {
    const k = `${s.name}:${(s.args ?? []).join(':')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function refreshChart({ force = false } = {}) {
  const ds = bars(state.symbol, state.tf);
  const inst = instrumentFor(state.symbol);
  const key = `${state.symbol}:${state.tf}:${ds.len}`;
  if (force || key !== cache.key || !cache.dataset) {
    cache = { key, dataset: ds, indicators: buildIndicatorSet(ds, ds.close.subarray(0, ds.len), overlaySpecs()) };
    state.barCount = ds.len;
  }
  const positions = [...account.positions.values()].filter((p) => p.symbol === state.symbol);
  const fills = account.fills
    .filter((f) => f.symbol === state.symbol)
    .slice(0, 60)
    .map((f) => ({ ...f, barT: Math.floor(f.at / 60000) * 60000 }));
  const strategySignals = [...engine.deployed.values()]
    .filter((e) => e.strategy.symbol === state.symbol && e.rt.lastSignal)
    .map((e) => ({ t: e.rt.lastSignal.at, side: e.rt.lastSignal.side, shadow: e.strategy.mode === 'shadow' }));
  chart.update({
    dataset: cache.dataset,
    indicators: cache.indicators,
    forming: inst.forming,
    quote: state.quote,
    meta: state.meta,
    provider: cfg.provider === 'rest' ? 'REST' : 'SIM',
    clockSpeedLabel: clock.speed === 1 ? 'realtime' : `${clock.speed / 60}min/sec`,
    bbKey: 'bb:20:2',
    positions,
    fills,
    strategySignals,
    priceLines: state.priceLines ?? [],
    showAutomation: state.showAutomation,
    view: {
      symbol: state.symbol,
      tf: state.tf,
      minutes: (TIMEFRAMES.find((t) => t.id === state.tf) ?? { minutes: 1 }).minutes,
      overlays: state.overlays,
      panes: state.panes,
    },
  });
}

/* ------------------------------------------------------------------ paint loop */

let paintQueued = false;
let lastPanelPaint = 0;

function schedule() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paint();
  });
}

function paint(forcePanels = false) {
  const qs = quotes();
  state.marks = Object.fromEntries(qs.map((q) => [q.symbol, q.last]));
  state.quote = qs.find((q) => q.symbol === state.symbol) ?? qs[0];
  state.meta = state.quote?.meta;
  state.watch = qs;
  refreshChart();
  topbar.render(state.quote, qs);
  watchlist.render(qs, universe());
  renderStatusbar();
  const now = Date.now();
  if (forcePanels || now - lastPanelPaint > 240) {
    lastPanelPaint = now;
    dock.render();
    consolePanel.render();
  }
  renderToolbar();
  renderToast();
}

/** Chart toolbar: timeframe + overlay + pane switches, rebuilt only when they change. */
let toolbarEl = chartHost.querySelector('[data-chartbar]');
function chip(label, on, onClick, tone = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip ${on ? 'is-on' : ''} ${tone}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderToolbar() {
  if (!toolbarEl) toolbarEl = chartHost.querySelector('[data-chartbar]');
  if (!toolbarEl) return;
  const stamp = `${state.tf}|${JSON.stringify(state.overlays)}|${JSON.stringify(state.panes)}|${state.showAutomation}`;
  if (toolbarEl.dataset.stamp === stamp) return;
  toolbarEl.dataset.stamp = stamp;
  toolbarEl.replaceChildren();

  const tfGroup = document.createElement('div');
  tfGroup.className = 'tb__group tb__group--tf';
  for (const t of TIMEFRAMES) {
    tfGroup.appendChild(chip(t.label, t.id === state.tf, () => set({ tf: t.id })));
  }

  const ovl = document.createElement('div');
  ovl.className = 'tb__group tb__group--ovl';
  const overlayTone = { ema20: 'c-cyan', ema50: 'c-amber', ema200: 'c-violet', vwap: 'c-lime', bb: 'c-lime', donchian: 'c-orange' };
  for (const [k, label] of [['ema20', 'EMA 20'], ['ema50', 'EMA 50'], ['ema200', 'EMA 200'], ['vwap', 'VWAP'], ['bb', 'BB(20,2)'], ['donchian', 'Donchian 20']]) {
    ovl.appendChild(
      chip(label, state.overlays[k], () => {
        // store write only — the subscription invalidates the indicator cache and
        // repaints, so the handler must not also force a rebuild (it would run twice)
        set({ overlays: { ...state.overlays, [k]: !state.overlays[k] } });
      }, overlayTone[k])
    );
  }

  const panes = document.createElement('div');
  panes.className = 'tb__group tb__group--panes';
  for (const [k, label] of [['volume', 'VOL'], ['rsi', 'RSI(14)'], ['macd', 'MACD']]) {
    panes.appendChild(
      chip(label, state.panes[k], () => set({ panes: { ...state.panes, [k]: !state.panes[k] } }))
    );
  }

  const right = document.createElement('div');
  right.className = 'tb__group tb__group--right';
  right.appendChild(
    chip('automation overlay', state.showAutomation, () => set({ showAutomation: !state.showAutomation }), 'c-green')
  );
  right.appendChild(
    chip(`levels ${(state.priceLines ?? []).length}`, false, () => {
      state.priceLines = [];
      refreshChart({ force: true });
      schedule();
    })
  );
  const bar = document.createElement('span');
  bar.className = 'tb__sym';
  bar.textContent = `${state.symbol}`;
  right.prepend(bar);

  toolbarEl.append(tfGroup, ovl, panes, document.createElement('span'), right);
}

function renderToast() {
  let el = document.getElementById('toast');
  if (!state.toast) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast toast--${state.toast.tone}`;
  el.textContent = state.toast.text;
}

/* ------------------------------------------------------------------ wiring */

on('tick', () => schedule());
on('bar', ({ tf, symbol }) => {
  if (tf === state.tf && symbol === state.symbol) refreshChart({ force: true });
  schedule();
});
on('status', ({ feed, provider }) => {
  engineLog('info', `feed ${feed} · provider ${provider}`);
  schedule();
});
on('clock', () => schedule());
subscribe(() => {
  delete cache.key;
  schedule();
});

chart.onPriceLines = (lines2) => {
  state.priceLines = lines2;
};
chart.onZoom = (v) => {
  state.barsBack = v.barsBack;
  state.offset = v.offset;
};

window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const syms = universe().map((u) => u.symbol);
  const i = syms.indexOf(state.symbol);
  switch (e.key) {
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
      set({ tf: TIMEFRAMES[Number(e.key) - 1].id });
      break;
    case 'ArrowRight':
      if (e.metaKey || e.ctrlKey) set({ symbol: syms[Math.min(syms.length - 1, i + 1)] });
      else chart.setVisible(state.barsBack, (state.offset ?? 0) + 10);
      break;
    case 'ArrowLeft':
      if (e.metaKey || e.ctrlKey) set({ symbol: syms[Math.max(0, i - 1)] });
      else chart.setVisible(state.barsBack, (state.offset ?? 0) - 10);
      break;
    case '+':
    case '=':
      chart.setVisible(state.barsBack * 0.82, state.offset ?? 0);
      break;
    case '-':
    case '_':
      chart.setVisible(state.barsBack * 1.22, state.offset ?? 0);
      break;
    case 'r':
    case 'R':
      chart.setVisible(170, 0);
      toast('chart view reset');
      break;
    case 'k':
    case 'K':
      topbar.render(state.quote, quotes());
      toast(account.killSwitch ? 'press RESUME in the top-right to release the halt' : 'KILL switch engaged — automation halted, positions flattened', 'bad', 6000);
      if (!account.killSwitch) {
        engageKillSwitch('keyboard');
        setAllHalted(true);
      }
      schedule();
      break;
    case '/':
      e.preventDefault();
      set({ activeTab: 'automate' });
      watchlist.focus();
      break;
    case ' ':
      e.preventDefault();
      clock.toggle();
      toast(clock.running ? 'feed running' : 'feed paused', 'info');
      break;
    default:
      break;
  }
});

/* live forming-bar animation keeps running even between feed ticks */
setInterval(() => chart.keepAlive(), 500);
startFeed({ provider: cfg.provider, intervalMs: cfg.provider === 'rest' ? 1000 : 420, onRest: () => boot('rest provider: awaiting gateway') });
clock.setSpeed(cfg.speed);
if (restored.length) engineLog('ok', `${restored.length} strategy re-armed from this browser's storage`);

await boot('ready', 60);
appEl.hidden = false;
bootEl.remove();
chart.resize();
paint(true);
logUi('GREEN TERMINAL online — paper account $250,000.00 · data provider: simulated market microstructure');
emit();

/** A UI-level notice into the engine log so the audit trail explains the session start. */
function logUi(text) {
  engineLog('info', text);
}

window.__GT = { state, set, chart, engine, account, clock, bars, toast, paint, refreshChart };
