import { h, patch, btn, badge, segmented } from './h.js';
import { fmtPrice, fmtMoney, fmtPct, fmtTime, signArrow, signClass } from '../modules/fmt.js';
import { clock } from '../modules/feed.js';
import { account, equity } from '../modules/broker.js';
import { engine } from '../modules/engine.js';
import { state } from '../modules/store.js';

export function createTopbar(host, { onKill, onSpeed, onResetDay }) {
  const price = h('b', { class: 'ticker__px', text: '—' });
  const chg = h('span', { class: 'ticker__chg', text: '' });
  const sym = h('span', { class: 'ticker__sym', text: state.symbol });
  const meta = h('span', { class: 'ticker__meta', text: '' });
  const eq = h('b', { class: 'acct__eq', text: '—' });
  const day = h('span', { class: 'acct__day', text: '' });
  const feedDot = h('i', { class: 'dot' });
  const feedText = h('span', { class: 'feed__t', text: 'sim' });
  const simClock = h('span', { class: 'feed__clock', text: '' });
  const autoStat = h('span', { class: 'auto__t', text: '0 armed' });
  const speed = segmented(
    [
      { id: '1', label: '1×' },
      { id: '60', label: '1m/s' },
      { id: '600', label: '10m/s' },
    ],
    String(clock.speed),
    (id) => onSpeed(Number(id))
  );
  const kill = btn('◼ KILL', () => onKill(!account.killSwitch), { tone: account.killSwitch ? 'danger-solid' : 'danger', title: 'Flatten everything and halt all automation' });

  host.innerHTML = `
    <div class="brand">
      <span class="brand__mark">▮▮▮</span>
      <span class="brand__name">GREEN<b>TERMINAL</b></span>
      <span class="brand__tag">analysis · automation · execution</span>
    </div>`;
  const ticker = h('div', { class: 'ticker' }, sym, price, chg, meta);
  const feed = h('div', { class: 'feed' }, feedDot, feedText, simClock);
  const acct = h('div', { class: 'acct' }, h('span', { class: 'acct__k', text: 'EQUITY' }), eq, day);
  const auto = h('div', { class: 'auto' }, h('span', { class: 'auto__k', text: 'AUTOMATION' }), autoStat);
  host.append(ticker, h('div', { class: 'topbar__spacer' }), speed, feed, auto, acct, kill);

  function render(quote, quotes) {
    const s = state.currentQuote ?? quote;
    patch(sym, { text: state.symbol });
    if (s) {
      patch(price, { text: fmtPrice(s.last, state.meta?.tick) });
      patch(price, { class: `ticker__px ${signClass(s.changePct)}` });
      patch(chg, { text: `${signArrow(s.changePct)} ${fmtPct(s.changePct)}`, class: `ticker__chg ${signClass(s.changePct)}` });
      const spread = s.spreadTicks ?? 1;
      const totVol = quotes.reduce((a, q) => a + Math.abs(q.changePct), 0) / Math.max(1, quotes.length);
      patch(meta, { text: `H ${fmtPrice(s.high, state.meta?.tick)}  L ${fmtPrice(s.low, state.meta?.tick)}  sprd ${spread}t  breadth ${(totVol * 100).toFixed(2)}%` });
    }
    const eqv = equity(state.marks);
    patch(day, { text: `${fmtMoney(eqv - account.dayStartEquity)} today` });
    patch(day, { class: `acct__day ${signClass(eqv - account.dayStartEquity)}` });
    patch(eq, { text: fmtMoney(eqv, { digits: 0 }) });
    patch(simClock, { text: fmtTime(clock.simNow) });
    patch(feedDot, { class: `dot ${clock.running ? 'dot--on' : 'dot--paused'}` });
    const armed = [...engine.deployed.values()].filter((e) => e.strategy.mode === 'armed').length;
    const shadow = [...engine.deployed.values()].filter((e) => e.strategy.mode === 'shadow').length;
    patch(autoStat, {
      text: account.killSwitch ? 'HALTED' : `${armed} armed · ${shadow} shadow`,
      class: `auto__t ${account.killSwitch ? 'down' : armed ? 'up' : ''}`,
    });
    patch(kill, {
      class: `btn btn--${account.killSwitch ? 'danger-solid' : 'danger'}`,
      text: account.killSwitch ? '▶ RESUME' : '◼ KILL',
    });
    void badge;
    void onResetDay;
  }
  return { render };
}
