/**
 * Right-hand dock: ticket / automation / risk / account.
 *
 * All four panels stay mounted and only the active one renders — tab state (a half-typed
 * rule, a running backtest, scroll position) survives switching, which is the difference
 * between a tool you can live in and one you fight with.
 */
import { h, mount, segmented } from './h.js';
import { state, set } from '../modules/store.js';
import { createTrade } from './trade.js';
import { createAutomation } from './automation.js';
import { createPositions } from './positions.js';
import { createAccount } from './account.js';
import { engine } from '../modules/engine.js';
import { account } from '../modules/broker.js';

export function createDock(host) {
  const tabsEl = h('div', { class: 'dock__tabs' });
  const slot = h('div', { class: 'dock__slot' });
  mount(host, tabsEl, slot);

  const panels = {};
  const refresh = () => {
    panels[state.activeTab]?.render();
  };

  const add = (id, cls, factory) => {
    const el = h('div', { class: `pane pane--${cls}`, hidden: state.activeTab !== id });
    slot.appendChild(el);
    const api = factory(el, { refresh });
    panels[id] = { el, ...api };
  };

  add('trade', 'trade', (el, ctx) => createTrade(el, ctx));
  add('automate', 'auto', (el) => createAutomation(el, { runLabel: () => 're-test' }));
  add('risk', 'pos', (el, ctx) => createPositions(el, ctx));
  add('account', 'acct', (el, ctx) => createAccount(el, ctx));

  function render(force = false) {
    const list = [
      { id: 'trade', label: 'TICKET' },
      { id: 'automate', label: 'AUTOMATE', badge: engine.deployed.size || null },
      { id: 'risk', label: 'RISK', badge: account.positions.size || null },
      { id: 'account', label: 'ACCOUNT' },
    ];
    mount(tabsEl, segmented(list, state.activeTab, (id) => set({ activeTab: id }), { size: 'xs' }));
    for (const [id, p] of Object.entries(panels)) {
      const on = state.activeTab === id;
      p.el.hidden = !on;
      if (on) p.render();
    }
    void force;
  }

  return { render, panels, renderAll: () => Object.values(panels).forEach((p) => p.render()) };
}
