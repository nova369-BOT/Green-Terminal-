/**
 * Account + risk configuration. The risk block is editable because risk parameters are
 * the trader's, not the developer's — but every bound is clamped to something that keeps
 * the account alive (e.g. the daily loss limit cannot be switched off entirely).
 */
import { h, mount, field, numberInput, kv, btn, hr, stat } from './h.js';
import { state, toast } from '../modules/store.js';
import { fmtMoney, fmtPct, fmtDuration } from '../modules/fmt.js';
import { account, equity, resetAccount, releaseKillSwitch, engageKillSwitch, closePosition } from '../modules/broker.js';
import { engine, log } from '../modules/engine.js';
import { drawSpark } from './chart.js';

export function createAccount(host, { refresh }) {
  const curve = h('canvas', { class: 'acct__curve', width: 320, height: 84 });
  const eqHistory = [];
  const body = h('div', { class: 'acct__body' });
  mount(host, h('div', { class: 'panel__head' }, h('h2', { text: 'ACCOUNT' }), h('span', { class: 'panel__hint', text: 'risk overlay' })), body);

  function render() {
    const eq = equity(state.marks ?? {});
    eqHistory.push(eq);
    if (eqHistory.length > 900) eqHistory.shift();
    const dayPnl = eq - account.dayStartEquity;
    const dd = eq / account.peakEquity - 1;
    const realised = account.realisedToday;
    const wins = account.fills.filter((f) => (f.pnl ?? 0) > 0).length;
    const losses = account.fills.filter((f) => f.pnl != null && f.pnl <= 0).length;

    mount(
      body,
      h('div', { class: 'acct__top' }, h('div', { class: 'acct__eq' }, h('b', { text: fmtMoney(eq, { digits: 2 }) }), h('span', { class: 'muted', text: account.name })), h('div', { class: 'acct__pnl' }, h('b', { class: dayPnl >= 0 ? 'up' : 'down', text: fmtMoney(dayPnl) }), h('span', { class: 'muted', text: fmtPct(eq ? dayPnl / eq : 0) }))),
      curve,
      h(
        'div',
        { class: 'stats stats--3' },
        stat('cash', fmtMoney(account.cash, { compact: true })),
        stat('day realised', fmtMoney(realised, { compact: true }), '', realised >= 0 ? 'up' : 'down'),
        stat('drawdown', fmtPct(dd), `peak ${fmtMoney(account.peakEquity, { compact: true })}`, dd < -0.03 ? 'down' : ''),
        stat('fees paid', fmtMoney(account.feePaid, { compact: true }), 'this session'),
        stat('fills', String(account.fills.length), `${wins}W / ${losses}L`),
      stat('gross', fmtPct(account.positions.size ? (eq ? [...account.positions.values()].reduce((a,p)=>a+p.qty*(p.mark??p.entry),0)/eq : 0) : 0), `${account.positions.size} positions`),
        stat('uptime', fmtDuration(processUptime()), `engine ${engine.evaluations} evals`)
      ),
      hr(),
      h('h3', { class: 'sec', text: 'RISK OVERLAY — enforced after every strategy decision' }),
      h(
        'div',
        { class: 'riskgrid' },
        field('fee', numberInput(account.risk.feeBps, (v) => bound('feeBps', v, 0, 50, 'bp'), { step: 0.5, suffix: 'bp' }), 'per side'),
        field('slippage', numberInput(account.risk.slippageBps, (v) => bound('slippageBps', v, 0, 60, 'bp'), { step: 0.5, suffix: 'bp' }), 'modelled adverse fill'),
        field('max positions', numberInput(account.risk.maxPositions, (v) => bound('maxPositions', v, 1, 40), { step: 1 }), 'concurrent'),
        field('max gross', numberInput(account.risk.maxGrossPct * 100, (v) => boundPct('maxGrossPct', v, 10, 400), { step: 5, suffix: '%' }), 'notional / equity'),
        field('daily loss limit', numberInput(account.risk.dailyLossLimitPct * 100, (v) => boundPct('dailyLossLimitPct', v, 0.5, 25), { step: 0.5, suffix: '%' }), 'flatten + halt'),
        field('hard risk cap', numberInput(account.risk.maxRiskPct * 100, (v) => boundPct('maxRiskPct', v, 0.1, 5), { step: 0.1, suffix: '%' }), 'per trade ceiling')
      ),
      hr(),
      h(
        'div',
        { class: 'acct__acts' },
        btn('flatten + halt', () => {
          // flatten first, then halt — order matters: a halt that leaves naked risk
          // running with nothing managing it is worse than no halt at all.
          for (const p of [...account.positions.values()]) closePosition(p.id, { price: (state.marks ?? {})[p.symbol], reason: 'manual kill switch', kind: 'flatten' });
          engageKillSwitch('manual');
          log('alert', 'kill switch engaged from account panel — all positions flattened');
          refresh();
        }, { tone: 'danger' }),
        btn('release halt', () => {
          releaseKillSwitch();
          toast('trading resumed — day P&L baseline reset');
          refresh();
        }, { tone: 'ghost' }),
        btn('reset session', () => {
          resetAccount(250000);
          eqHistory.length = 0;
          toast('paper account reset to $250,000.00');
          refresh();
        }, { tone: 'ghost' })
      ),
      h(
        'details',
        { class: 'acct__prov' },
        h('summary', { text: 'data + execution topology' }),
        h('div', { class: 'topo' }, kv('provider', 'sim (deterministic jump-diffusion)'), kv('venue map', 'GREENX · GREENUS · GREENFX · GREENIDX'), kv('execution', 'paper broker, shared sizing core'), kv('bar contract', 'strategies see CLOSED bars only'), kv('real feed', 'src/modules/feed.js → createProvider({provider:"rest"})'), kv('state', 'in-memory; strategies persist to localStorage'))
      )
    );
    drawSpark(curve, eqHistory, { color: eq >= account.dayStartEquity ? '#2ee08a' : '#ff5470', baseline: account.dayStartEquity, height: 84 });
  }

  function bound(key, value, min, max, unit = '') {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    account.risk[key] = Math.max(min, Math.min(max, v));
    toast(`risk.${key} = ${v}${unit}`);
    render();
  }
  function boundPct(key, value, min, max) {
    bound(key, Number(value) / 100, min / 100, max / 100);
  }
  const processUptime = () => (state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0);

  return { render };
}
