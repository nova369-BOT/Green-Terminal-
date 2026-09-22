/**
 * Positions + blotter. Open risk first, then working orders, then history — that is the
 * order a trader actually reads it in, so the DOM order matches the mental model.
 */
import { h, mount, patch, btn, badge, empty } from './h.js';
import { state, toast } from '../modules/store.js';
import { fmtPrice, fmtMoney, fmtQty, fmtPct, fmtTime, signClass, fmtDuration } from '../modules/fmt.js';
import { account, closePosition, equity, metaFor } from '../modules/broker.js';
import { engine } from '../modules/engine.js';

export function createPositions(host, { refresh }) {
  const body = h('div', { class: 'pos__body' });
  mount(
    host,
    h(
      'div',
      { class: 'panel__head' },
      h('h2', { text: 'RISK' }),
      h('span', { class: 'panel__hint pos__head' , text: '' })
    ),
    body
  );

  function render() {
    const positions = [...account.positions.values()];
    const eq = equity(state.marks);
    const gross = positions.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0);
    const unreal = positions.reduce((a, p) => a + (p.unrealised ?? 0), 0);
    patch(host.querySelector('.pos__head'), {
      text: `${positions.length} open · ${((gross / eq) * 100).toFixed(0)}% gross · ${fmtMoney(unreal, { compact: false })} open P&L`,
    });

    // both branches must be ARRAYS — mount(body, ...cards) spreads, and spreading a
    // lone DOM element (not iterable) throws inside every paint afterwards
    const cards = positions.length
      ? positions.map((p) => {
          const meta = p.meta ?? metaFor(p.symbol);
          const r = p.rMultiple;
          return h(
            'div',
            { class: `pos__card pos--${p.side}` },
            h(
              'div',
              { class: 'pos__top' },
              h('b', { class: 'pos__sym', text: p.symbol }),
              badge(p.side, p.side === 'long' ? 'up' : 'down'),
              badge(p.strategyName, 'muted'),
              h('span', { class: 'pos__age', text: fmtDuration((Date.now() - p.openedAt) / 1000) })
            ),
            h(
              'div',
              { class: 'pos__nums' },
              h('div', {}, h('span', { text: 'size' }), h('b', { text: `${fmtQty(p.qty, meta.qtyStep < 1 ? 5 : 0)}` })),
              h('div', {}, h('span', { text: 'entry' }), h('b', { text: fmtPrice(p.entry, meta.tick) })),
              h('div', {}, h('span', { text: 'mark' }), h('b', { text: fmtPrice(p.mark ?? p.entry, meta.tick) })),
              h('div', {}, h('span', { text: 'stop' }), h('b', { text: p.stop ? fmtPrice(p.stop, meta.tick) : '—' })),
              h('div', {}, h('span', { text: 'target' }), h('b', { text: p.take ? fmtPrice(p.take, meta.tick) : '—' })),
              h(
                'div',
                {},
                h('span', { text: 'unrealised' }),
                h('b', { class: signClass(p.unrealised ?? 0), text: `${fmtMoney(p.unrealised ?? 0)} (${fmtPct(p.unrealisedPct ?? 0)})` })
              )
            ),
            h(
              'div',
              { class: 'pos__meter' },
              h('i', { class: 'pos__meterFill', style: { width: `${Math.min(100, Math.max(0, ((r ?? 0) + 1) * 50))}%` } }),
              h('span', { class: 'pos__meterT', text: r != null ? `${r >= 0 ? '+' : ''}${r.toFixed(2)}R` : 'no stop — R unknown' })
            ),
            h(
              'div',
              { class: 'pos__acts' },
              btn('close', () => {
                closePosition(p.id, { price: state.marks?.[p.symbol], reason: 'manual close', kind: 'exit' });
                refresh();
              }, { tone: 'danger', cls: 'xs' }),
              btn('half', () => {
                // close exactly half, snapped DOWN to the lot grid (a partial must
                // never exceed the half we intended to scale out)
                const step = meta.qtyStep || 1;
                const half = Math.floor(p.qty / 2 / step) * step;
                closePosition(p.id, { price: state.marks?.[p.symbol], qty: half, reason: 'scale out 50%', kind: 'exit' });
                refresh();
              }, { tone: 'ghost', cls: 'xs', title: 'Reduce half' }),
              btn('break-even', () => {
                p.stop = p.entry + (p.side === 'long' ? 1 : -1) * meta.tick * 4;
                toast(`${p.symbol} stop moved to ${fmtPrice(p.stop, meta.tick)} (break-even)`);
                refresh();
              }, { tone: 'ghost', cls: 'xs' }),
              p.trail ? badge(`trail ${p.trail.mult ?? ''}×ATR`, 'info') : null
            ),
            h('p', { class: 'pos__why', text: `why: ${p.reason}` })
          );
        })
      : [empty('no open risk', 'the terminal is flat — deploy a strategy or send an order from the ticket')];

    const orders = account.orders.length
      ? h(
          'div',
          { class: 'pos__orders' },
          h('h3', { text: `WORKING ORDERS (${account.orders.length})` }),
          ...account.orders.map((o) =>
            h(
              'div',
              { class: 'order' },
              h('b', { text: `${o.side} ${fmtQty(o.qty)} ${o.symbol}` }),
              h('span', { text: `limit ${fmtPrice(o.limit, metaFor(o.symbol).tick)}` }),
              h('span', { class: 'muted', text: fmtTime(o.at) }),
              btn('cancel', () => {
                account.orders = account.orders.filter((x) => x !== o);
                refresh();
              }, { tone: 'ghost', cls: 'xs' })
            )
          )
        )
      : null;

    const fills = account.fills.slice(0, 40);
    const blot = h(
      'div',
      { class: 'blot' },
      h('h3', { text: 'BLOTTER' }),
      fills.length
        ? h(
            'table',
            { class: 'tbl' },
            h('thead', {}, h('tr', {}, ...['time', 'sym', 'side', 'qty', 'price', 'fee', 'p&l', 'strategy / note'].map((t) => h('th', { text: t })))),
            h(
              'tbody',
              {},
              ...fills.map((f) =>
                h(
                  'tr',
                  {},
                  h('td', { text: fmtTime(f.at) }),
                  h('td', { text: f.symbol }),
                  h('td', { class: f.side === 'long' ? 'up' : 'down', text: f.side === 'long' ? 'L' : 'S' }),
                  h('td', { text: fmtQty(f.qty, 5) }),
                  h('td', { text: fmtPrice(f.price, metaFor(f.symbol)?.tick) }),
                  h('td', { text: f.fee ? f.fee.toFixed(2) : '0' }),
                  h('td', { class: signClass(f.pnl ?? 0), text: f.pnl != null ? (f.pnl >= 0 ? '+' : '') + f.pnl.toFixed(2) : '—' }),
                  h('td', { class: 'blot__note', text: `${f.strategy} · ${f.kind} · ${f.note}` })
                )
              )
            )
          )
        : empty('no fills yet')
    );

    mount(body, ...cards, orders, blot);
    void engine;
  }

  return { render };
}
