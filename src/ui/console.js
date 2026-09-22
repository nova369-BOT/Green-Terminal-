/**
 * Engine console — the audit trail. Append-only, filterable, and the single place a
 * trader can see *why* the terminal did something (or refused to). A rejection with a
 * reason is worth more than a silent skip, so rejections are first-class here.
 */
import { h, mount, patch, segmented } from './h.js';
import { engine } from '../modules/engine.js';
import { state, set } from '../modules/store.js';
import { fmtTime } from '../modules/fmt.js';

const FILTERS = [
  { id: 'all', label: 'all' },
  { id: 'exec', label: 'exec' },
  { id: 'shadow', label: 'shadow' },
  { id: 'risk', label: 'risk' },
  { id: 'reject', label: 'reject' },
  { id: 'alert', label: 'alert' },
];

export function createConsole(host) {
  let pinned = true;
  mount(
    host,
    h(
      'div',
      { class: 'console__bar' },
      h('h2', { class: 'console__title', text: 'ENGINE LOG' }),
      segmented(FILTERS, state.consoleFilter, (id) => set({ consoleFilter: id }), { size: 'xs' }),
      h(
        'span',
        { class: 'console__stats' },
        h('b', { class: 'cs cs--eval', text: '0' }),
        h('span', { text: 'evals' }),
        h('b', { class: 'cs cs--sig', text: '0' }),
        h('span', { text: 'signals' }),
        h('b', { class: 'cs cs--rej', text: '0' }),
        h('span', { text: 'refused' })
      ),
      h('button', { class: 'icon', type: 'button', title: 'collapse', onClick: () => set({ consoleOpen: !state.consoleOpen }), text: state.consoleOpen ? '▾' : '▴' }),
      h('button', { class: 'icon', type: 'button', title: 'clear', onClick: () => { engine.log.length = 0; render(); }, text: '✕' })
    ),
    h('div', { class: 'console__stream', tabindex: '0' })
  );
  const stream = host.querySelector('.console__stream');
  const statE = host.querySelector('.cs--eval');
  const statS = host.querySelector('.cs--sig');
  const statR = host.querySelector('.cs--rej');

  stream.addEventListener('scroll', () => {
    pinned = stream.scrollTop < 4; // log is newest-first: pinned = showing the top
  });

  function render() {
    patch(host, { class: `console ${state.consoleOpen ? '' : 'console--closed'}` });
    const items = engine.log.filter((l) => state.consoleFilter === 'all' || l.level === state.consoleFilter).slice(0, 200);
    patch(statE, { text: String(engine.evaluations) });
    patch(statS, { text: String(engine.signals) });
    patch(statR, { text: String(engine.rejections) });
    if (!items.length) {
      mount(stream, h('p', { class: 'console__none', text: 'no engine events yet — deploy a strategy in shadow mode and wait for the next closed bar' }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const l of items) {
      frag.appendChild(
        h(
          'div',
          { class: `log log--${l.level}` },
          h('time', { text: fmtTime(l.at) }),
          h('span', { class: 'log__lvl', text: l.level.toUpperCase() }),
          l.symbol ? h('span', { class: 'log__sym', text: l.symbol }) : null,
          h('span', { class: 'log__txt', text: l.text })
        )
      );
    }
    mount(stream, frag);
    if (!pinned) stream.scrollTop = 0;
  }

  return { render };
}
