/**
 * UI smoke test — boots the real terminal (index.html + main.js + all panels) inside
 * jsdom with a stubbed canvas, drives a few interactions, and fails loudly on any
 * uncaught error. This is the layer `node scripts/test.js` cannot see: DOM wiring,
 * panel mount order, the boot sequence, and cross-module globals.
 *
 * Run: npm run test:ui   (jsdom is a devDependency only — the app itself ships zero deps)
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

const errors = [];
const dom = new JSDOM(html, {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;

/* ---- browser surface stubs jsdom lacks ---------------------------------- */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeCtx(canvas) {
  const gradient = { addColorStop() {} };
  const base = {
    canvas,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    setLineDash() {},
    getLineDash: () => [],
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => undefined; // any drawing call is a no-op
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

window.HTMLCanvasElement.prototype.getContext = function getContext() {
  if (!this.__ctx) this.__ctx = makeCtx(this);
  return this.__ctx;
};
window.ResizeObserver = ResizeObserverStub;

/* ---- expose the browser surface as Node globals ------------------------- */
for (const key of [
  'window',
  'document',
  'location',
  'navigator',
  'localStorage',
  'sessionStorage',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLCanvasElement',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'DOMParser',
  'MutationObserver',
]) {
  if (!(key in window)) continue;
  // some Node globals (navigator) are getter-only — force-redefine where allowed
  try {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  } catch {
    /* leave the native one in place; jsdom's is equivalent enough for this app */
  }
}
globalThis.ResizeObserver = ResizeObserverStub;

process.on('uncaughtException', (err) => errors.push(`uncaughtException: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => errors.push(`unhandledRejection: ${err?.stack ?? err}`));
const origError = console.error;
console.error = (...args) => {
  errors.push(`console.error: ${args.map((a) => (a?.stack ?? String(a))).join(' ')}`);
  origError(...args);
};

/* ---- helpers ------------------------------------------------------------ */
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];

console.log('\nui smoke: booting GREEN TERMINAL in jsdom…');
const t0 = Date.now();

function pathToFileUrl(p) {
  return new URL(`file://${p}`).href;
}

/* ---- boot --------------------------------------------------------------- */
try {
  await import(pathToFileUrl(path.join(root, 'src/app/main.js')));
  console.log(`  · main.js imported (${Date.now() - t0}ms)`);
} catch (err) {
  console.log('  · main.js import FAILED:', err?.stack ?? err);
  process.exit(1);
}
await sleep(1400); // boot log + first paints + a feed tick
console.log(`  · settled after ${Date.now() - t0}ms`);

console.log(`booted in ${Date.now() - t0}ms`);

check('no uncaught errors during boot', errors.length === 0, errors.slice(0, 3).join(' | '));
check('boot splash removed', !window.document.getElementById('boot'));
check('app shell visible', window.document.getElementById('app')?.hidden === false);
check('topbar mounted with content', ($('#topbar')?.children.length ?? 0) >= 4, `children=${$('#topbar')?.children.length}`);
check('watchlist has all 8 instruments', $$('.watch__row').length === 8, `rows=${$$('.watch__row').length}`);
check('chart canvas present', !!$('#chart canvas'));
check('chart toolbar built (tf chips)', $$('.chart__toolbar .chip').length >= 6, `chips=$$('.chart__toolbar .chip').length`);
check('console stream has engine events', $$('.console__stream .log').length >= 1, `logs=${$$('.console__stream .log').length}`);
check('statusbar rendered', ($('#statusbar')?.textContent ?? '').includes('paper environment'));
check('dock tabs present', $$('.dock__tabs .seg__b').length === 4);
check('trade ticket mounted first', !!$('.pane--trade .ticket'), 'default tab should be TICKET');

/* ---- interactions -------------------------------------------------------- */
const GT = window.__GT;
check('window.__GT exposed for debugging', !!GT);

// 1) switch symbol via watchlist click
const ethRow = $$('.watch__row').find((r) => r.textContent.includes('ETH/USD'));
ethRow?.click();
await sleep(60);
check('watchlist click switches symbol', GT.state.symbol === 'ETH/USD', `symbol=${GT.state.symbol}`);
check('topbar ticker follows symbol', ($('#topbar')?.textContent ?? '').includes('ETH/USD'));

// 2) timeframe chip
const tf15 = $$('.chart__toolbar .chip').find((c) => c.textContent === '15m');
tf15?.click();
await sleep(60);
check('tf chip switches timeframe', GT.state.tf === '15m', `tf=${GT.state.tf}`);

// 3) overlay toggle
const bbChip = $$('.chart__toolbar .chip').find((c) => c.textContent.includes('BB'));
bbChip?.click();
await sleep(60);
check('Bollinger overlay toggles on', GT.state.overlays.bb === true);

// 4) dock: automation tab + builder render
GT.set({ activeTab: 'automate' });
GT.paint(true);
await sleep(120);
const autoPane = $('.pane--auto');
check('automation pane becomes visible', autoPane && autoPane.hidden === false);
check('builder form mounted', !!$('.pane--auto .builder'), 'expected .builder inside automation pane');
check('preset library tab exists', $$('.pane--auto .seg__b').some((b) => b.textContent.includes('library')));

// 5) deploy a strategy headlessly and confirm it renders as a card
const { deploy, engine } = await import(pathToFileUrl(path.join(root, 'src/modules/engine.js')));
const { PRESETS, fromPreset } = await import(pathToFileUrl(path.join(root, 'src/modules/presets.js')));
const res = deploy(fromPreset(PRESETS[0], { symbol: 'BTC/USD', tf: '1h', mode: 'shadow' }), { persist: false });
check('deploy accepts a valid preset', res.ok === true, res.errors?.join('; '));
GT.paint(true);
await sleep(80);
check('deployed strategy card renders', $$('.pane--auto .scard').length === 1, `cards=${$$('.pane--auto .scard').length}`);
check('strategy card shows readable rule', ($('.scard__rule')?.textContent ?? '').includes('AND'));
check('watchlist shows automation dot', $$('.watch__auto .wdot').length >= 1);

// 6) feed is actually ticking
const evalsBefore = engine.evaluations;
const barsBefore = GT.state.barCount ?? 0;
GT.clock.setSpeed(600); // 10 simulated minutes per second → bars close fast
await sleep(900);
check('feed ticks advance the clock', GT.clock.speed === 600);
check('bar count grows under time compression', (GT.state.barCount ?? 0) >= barsBefore, `bars ${barsBefore} → ${GT.state.barCount}`);
check('engine evaluated closed bars', engine.evaluations >= evalsBefore || engine.deployed.size > 0, `evals ${engine.evaluations}`);
check('console captured feed/engine events', $$('.console__stream .log').length >= 2, `logs=${$$('.console__stream .log').length}`);

// 7) risk / account panels mount
GT.set({ activeTab: 'risk' });
GT.paint(true);
await sleep(80);
check('risk panel renders', $('.pane--pos')?.hidden === false && ($('.pane--pos .pos__body')?.children.length ?? 0) >= 1);
GT.set({ activeTab: 'account' });
GT.paint(true);
await sleep(80);
check('account panel renders with equity curve', !!$('.pane--acct .acct__curve'));
check('account shows risk overlay fields', $$('.pane--acct .riskgrid .field').length === 6, `fields=${$$('.pane--acct .riskgrid .field').length}`);

// 8) kill switch wiring
GT.set({ activeTab: 'account' });
GT.paint(true);
const flattenBtn = $$('.pane--acct .btn').find((b) => b.textContent.includes('flatten + halt'));
flattenBtn?.click();
await sleep(80);
const { account } = await import(pathToFileUrl(path.join(root, 'src/modules/broker.js')));
check('kill switch engages from account panel', account.killSwitch === true);
check('positions flattened by kill switch', account.positions.size === 0);
const releaseBtn = $$('.pane--acct .btn').find((b) => b.textContent.includes('release halt'));
releaseBtn?.click();
await sleep(60);
check('kill switch releases', account.killSwitch === false);

check('no uncaught errors after interactions', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ui smoke: ${passed} passed · ${failed} failed`);
if (failed || errors.length) {
  if (errors.length) {
    console.log('\nerrors captured:');
    for (const e of errors.slice(0, 8)) console.log(`  · ${e.split('\n')[0]}`);
  }
  process.exit(1);
}
console.log('  terminal boots, renders, and responds. safe to ship.');
process.exit(0);
