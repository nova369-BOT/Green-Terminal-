/**
 * Order ticket. Everything here is *intent* — validation and risk live in the broker,
 * so a hand-typed order passes the same gates as an automated one. Sizing is shown in
 * risk units first and units second, because that is the decision that actually matters.
 */
import { h, mount, patch, btn, field, numberInput, select, segmented, kv, hr, badge } from './h.js';
import { state, set, toast } from '../modules/store.js';
import { fmtPrice, fmtMoney, fmtQty, pad2 } from '../modules/fmt.js';
import { account, openPosition, sizePosition, positionFor, closePosition, metaFor, equity } from '../modules/broker.js';
import { buildDepth } from '../modules/sim.js';

export function createTrade(host, { refresh }) {
  const form = {
    type: 'market',
    tif: 'GTC',
    qty: null,
    notionalPct: 8,
    limit: null,
    stopPct: 1.2,
    takePct: 3,
    sizeMode: 'equityPct',
    reduceOnly: false,
  };
  let preview = null;

  const sizeModeSeg = segmented(
    [
      { id: 'equityPct', label: '% equity', title: 'Notional as a share of equity' },
      { id: 'riskBudget', label: '% risk', title: 'Size so the stop loses only this much' },
      { id: 'fixedQty', label: 'units', title: 'Absolute quantity' },
    ],
    form.sizeMode,
    (id) => {
      form.sizeMode = id;
      render();
    },
    { size: 'xs' }
  );

  const sideSeg = segmented(
    [
      { id: 'long', label: 'BUY / LONG' },
      { id: 'short', label: 'SELL / SHORT' },
    ],
    'long',
    (id) => {
      form.side = id;
      render();
    }
  );

  const previewBox = h('div', { class: 'ticket__preview' });
  const submit = btn('SUBMIT', () => send(), { tone: 'primary', cls: 'ticket__go' });

  function send() {
    const meta = metaFor(state.symbol);
    const px = form.type === 'market' ? (state.quote?.last ?? 0) : Number(form.limit) || state.quote?.last || 0;
    const eq = equity(state.marks);
    const strategy = {
      sizing: { mode: form.sizeMode, value: form.sizeMode === 'equityPct' ? form.notionalPct / 100 : form.sizeMode === 'riskBudget' ? (form.notionalPct ?? 0.5) / 100 : Number(form.qty) },
    };
    const d = form.side === 'long' ? 1 : -1;
    const stop = form.stopPct ? px - d * px * (form.stopPct / 100) : null;
    const take = form.takePct ? px + d * px * (form.takePct / 100) : null;
    const size = sizePosition({ strategy, equityValue: eq, entry: px, stop, meta, side: form.side });
    if (!size.ok) return toast(size.msg, 'bad');
    const res = openPosition({
      symbol: state.symbol,
      side: form.side,
      qty: size.qty,
      entry: px,
      strategy: { id: null, name: 'manual' },
      type: form.type,
      limit: px,
      stop,
      take,
      reason: `manual ${form.type}${form.reduceOnly ? ' · reduce-only' : ''}`,
      marks: state.marks,
    });
    if (!res.ok) return toast(res.msg, 'bad');
    if (res.resting) toast(`working ${form.side} ${fmtQty(size.qty)} ${state.symbol} @ ${fmtPrice(res.limit, meta.tick)}`, 'ok');
    else toast(`filled ${form.side} ${fmtQty(size.qty)} ${state.symbol} @ ${fmtPrice(res.fill, meta.tick)}`, 'ok');
    refresh();
  }

  function render() {
    const meta = state.meta ?? metaFor(state.symbol);
    const px = state.quote?.last ?? 0;
    const eq = equity(state.marks);
    const d = form.side === 'short' ? -1 : 1;
    const stop = form.stopPct ? px - d * px * (form.stopPct / 100) : null;
    const take = form.takePct ? px + d * px * (form.takePct / 100) : null;
    const strategy = {
      sizing: { mode: form.sizeMode, value: form.sizeMode === 'equityPct' ? form.notionalPct / 100 : form.sizeMode === 'riskBudget' ? (form.notionalPct ?? 0.5) / 100 : Number(form.qty) || 1 },
    };
    preview = sizePosition({ strategy, equityValue: eq, entry: px, stop, meta, side: form.side });
    const held = positionFor(state.symbol);

    mount(
      host,
      h(
        'div',
        { class: 'panel__head' },
        h('h2', { text: 'TICKET' }),
        h('span', { class: 'panel__hint', text: `${state.symbol} · ${pad2(new Date().getUTCHours())}:${pad2(new Date().getUTCMinutes())} UTC` })
      ),
      h('div', { class: 'ticket' }, sideSeg, sizeModeSeg, field(
        form.sizeMode === 'fixedQty' ? 'quantity' : form.sizeMode === 'riskBudget' ? 'risk per trade' : 'position size',
        form.sizeMode === 'fixedQty'
          ? numberInput(form.qty ?? '', (v) => {
              form.qty = v;
              render();
            }, { step: meta.qtyStep, suffix: 'units' })
          : h(
              'div',
              { class: 'slider' },
              h('input', {
                type: 'range',
                min: form.sizeMode === 'riskBudget' ? '0.1' : '1',
                max: form.sizeMode === 'riskBudget' ? '3' : '100',
                step: form.sizeMode === 'riskBudget' ? '0.1' : '1',
                value: String(form.notionalPct),
                onInput: (e) => {
                  form.notionalPct = Number(e.target.value);
                  render();
                },
              }),
              numberInput(form.notionalPct, (v) => {
                form.notionalPct = v;
                render();
              }, { step: 0.1, suffix: '%', cls: 'slider__num' })
            ),
        form.sizeMode === 'riskBudget' ? 'sizing so a stop-out loses only this share of equity' : form.sizeMode === 'equityPct' ? 'notional held, as a share of equity' : 'absolute contract quantity'
      ),
        select(form.type, [
          { value: 'market', label: 'Market — fill at touch + slippage' },
          { value: 'limit', label: 'Limit — work until price crosses' },
        ], (v) => {
          form.type = v;
          render();
        }),
        form.type === 'limit'
          ? field('limit price', numberInput(form.limit ?? px, (v) => {
              form.limit = v;
              render();
            }, { step: meta.tick }), 'rests in the book until crossed')
          : null,
        h(
          'div',
          { class: 'ticket__bracket' },
          field('stop loss', numberInput(form.stopPct, (v) => {
            form.stopPct = v;
            render();
          }, { step: 0.1, suffix: '%', cls: 'sm' }), stop != null ? `@ ${fmtPrice(stop, meta.tick)}` : 'none'),
          field('take profit', numberInput(form.takePct, (v) => {
            form.takePct = v;
            render();
          }, { step: 0.1, suffix: '%', cls: 'sm' }), take != null ? `@ ${fmtPrice(take, meta.tick)}` : 'none')
        ),
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: form.reduceOnly, onChange: (e) => (form.reduceOnly = e.target.checked) }),
          h('span', { text: 'reduce-only (close existing, never open)' })
        ),
        previewBox,
        submit,
        held ? h('div', { class: 'ticket__held' }, h('span', { text: `held: ${held.side} ${fmtQty(held.qty)} @ ${fmtPrice(held.entry, meta.tick)}` }), btn('flatten', () => {
          closePosition(held.id, { price: px, reason: 'manual flatten', kind: 'exit' });
          refresh();
        }, { tone: 'danger', cls: 'xs' })) : null
      )
    );

    const rr = preview?.ok && stop && take ? Math.abs(take - px) / Math.abs(px - stop) : null;
    mount(
      previewBox,
      preview?.ok
        ? h(
            'div',
            { class: 'preview' },
            h(
              'div',
              { class: 'preview__grid' },
              kv('fills at', `≈ ${fmtPrice(preview.fill, meta.tick)}`),
              kv('quantity', `${fmtQty(preview.qty, meta.qtyStep < 1 ? 6 : 0)} ${state.symbol}`),
              kv('notional', fmtMoney(preview.gross, { compact: true })),
              kv('est. fees', fmtMoney(preview.fees, { digits: 2 })),
              kv('risk to stop', stop ? fmtMoney(Math.abs(px - stop) * preview.qty, { digits: 2 }) : '—', stop ? 'down' : ''),
              kv('R:R', rr ? `1 : ${rr.toFixed(2)}` : '—', rr && rr >= 1.5 ? 'up' : rr ? 'warn' : '')
            ),
            h('p', { class: 'preview__basis', text: `sized by ${preview.basis} · ${(account.risk.feeBps / 100).toFixed(2)}% fee · ${(account.risk.slippageBps / 100).toFixed(2)}% slip` })
          )
        : h('p', { class: 'preview__err', text: preview?.msg ?? 'adjust size' })
    );
    void badge;
    void hr;
    void set;
  }

  function renderDepth() {
    const meta = state.meta ?? metaFor(state.symbol);
    const book = buildDepth(meta, state.quote?.last ?? meta.start, 10);
    const max = Math.max(...book.bids.map((b) => b.qty), ...book.asks.map((a) => a.qty));
    return h(
      'div',
      { class: 'book' },
      h('div', { class: 'book__head' }, h('span', { text: 'BIDS' }), h('span', { text: 'ASKS' })),
      h(
        'div',
        { class: 'book__rows' },
        ...[...book.asks].reverse().map((a) =>
          h(
            'div',
            { class: 'book__ask' },
            h('span', { class: 'bar', style: { width: `${(a.qty / max) * 100}%` } }),
            h('b', { text: fmtPrice(a.price, meta.tick) }),
            h('span', { text: fmtQty(a.qty, 2) })
          )
        )
      ),
      h('div', { class: 'book__mid' }, h('b', { text: fmtPrice(state.quote?.last ?? 0, meta.tick) }), h('span', { text: 'mid' })),
      h(
        'div',
        { class: 'book__rows' },
        ...book.bids.map((b) =>
          h(
            'div',
            { class: 'book__bid' },
            h('span', { class: 'bar', style: { width: `${(b.qty / max) * 100}%` } }),
            h('b', { text: fmtPrice(b.price, meta.tick) }),
            h('span', { text: fmtQty(b.qty, 2) })
          )
        )
      )
    );
  }

  return { render, renderDepth };
}
