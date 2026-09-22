/**
 * Watchlist. Every row is a live instrument with its own sparkline; a row also carries
 * the automation footprint for that symbol, because the first question after a signal
 * is always "what am I already running on this?"
 */
import { h, mount, patch, textInput, debounce, badge } from './h.js';
import { drawSpark } from './chart.js';
import { fmtPrice, fmtPct, signClass, signArrow, fmtMoney } from '../modules/fmt.js';
import { state, set } from '../modules/store.js';
import { engine } from '../modules/engine.js';
import { instrumentFor } from '../modules/feed.js';

export function createWatchlist(host) {
  const search = textInput('', (v) => {
    filter(v);
  }, { placeholder: 'filter  /', cls: 'search' });
  const list = h('div', { class: 'watch__list' });
  mount(
    host,
    h(
      'div',
      { class: 'panel__head' },
      h('h2', { text: 'MARKETS' }),
      h('span', { class: 'panel__hint', text: '↑/↓' })
    ),
    h('div', { class: 'watch__search' }, search),
    list,
    h('div', { class: 'watch__foot' }, h('span', { class: 'watch__footT', text: '' }))
  );
  const rows = new Map();
  let query = '';

  function filter(v) {
    query = v.trim().toLowerCase();
    for (const [sym, el] of rows) patch(el, { style: { display: !query || sym.toLowerCase().includes(query) ? '' : 'none' } });
  }

  function render(quotes, universe) {
    const foot = host.querySelector('.watch__footT');
    let up = 0;
    for (const q of quotes) {
      up += q.changePct > 0 ? 1 : 0;
      let el = rows.get(q.symbol);
      if (!el) {
        el = buildRow(q.symbol);
        rows.set(q.symbol, el);
        list.appendChild(el.root);
      }
      const armed = [...engine.deployed.values()].filter((e) => e.strategy.symbol === q.symbol);
      patch(el.px, { text: fmtPrice(q.last, q.meta?.tick ?? 0.01), class: `watch__px ${signClass(q.changePct)}` });
      patch(el.chg, { text: `${signArrow(q.changePct)}${fmtPct(q.changePct, 2)}`, class: `watch__chg ${signClass(q.changePct)}` });
      patch(el.vol, { text: `vol ${fmtMoney(q.volume, { symbol: '', compact: true })}` });
      patch(el.root, { class: `watch__row ${q.symbol === state.symbol ? 'is-active' : ''}` });
      const dot = armed.filter((a) => a.strategy.mode === 'armed').length;
      const shadow = armed.filter((a) => a.strategy.mode === 'shadow').length;
      patch(el.auto, {
        html: armed.length
          ? `${dot ? `<i class="wdot wdot--on" title="${dot} armed"></i>` : ''}${shadow ? `<i class="wdot wdot--watch" title="${shadow} shadow"></i>` : ''}`
          : '',
      });
      // real 1-minute closes for the trailing window, not a decorative squiggle
      const closes = instrumentFor(q.symbol).snapshot(1).close;
      const from = Math.max(0, closes.length - 240);
      const vals = [];
      for (let i = from; i < closes.length; i += 4) vals.push(closes[i]);
      drawSpark(el.spark, vals, {
        color: q.changePct >= 0 ? '#2ee08a' : '#ff5470',
        baseline: vals[0],
      });
    }
    patch(foot, { text: `${quotes.length} instruments · ${up} green` });
  }

  function buildRow(symbol) {
    const px = h('b', { class: 'watch__px', text: '' });
    const chg = h('span', { class: 'watch__chg', text: '' });
    const vol = h('span', { class: 'watch__vol', text: '' });
    const spark = h('canvas', { class: 'watch__spark', width: 60, height: 26 });
    const auto = h('span', { class: 'watch__auto', html: '' });
    const root = h(
      'button',
      {
        class: 'watch__row',
        type: 'button',
        onClick: () => set({ symbol }),
        onKeydown: (e) => {
          if (e.key === 'ArrowDown') host.querySelectorAll('.watch__row')[[...host.querySelectorAll('.watch__row')].indexOf(root) + 1]?.focus();
          if (e.key === 'ArrowUp') host.querySelectorAll('.watch__row')[[...host.querySelectorAll('.watch__row')].indexOf(root) - 1]?.focus();
        },
      },
      h('span', { class: 'watch__sym' }, h('b', { text: symbol }), auto),
      spark,
      h('span', { class: 'watch__nums' }, px, chg, vol)
    );
    return { root, px, chg, vol, spark, auto };
  }

  return { render, focus: () => search.focus() };
}
