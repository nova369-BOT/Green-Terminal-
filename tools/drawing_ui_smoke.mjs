// Unified drawing-toolbar UI smoke.
//
// Loads the deployed production bundle in JSDOM, mounts the real TerminalChart,
// and verifies that the TARGET control restores BOTH, toggles to ONE, and emits
// the same symbol-aware bridge events consumed by the shell. The canvas itself
// is represented by a no-op 2D context: this test owns toolbar/bridge behavior;
// tools/chart_smoke.mjs owns real-browser painting.
//
// Run from anywhere after installing frontend dependencies plus jsdom:
//   cd frontend && npm i --no-save --package-lock=false jsdom
//   node ../tools/drawing_ui_smoke.mjs
// Exit 0 with SKIP means jsdom is not installed.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

let JSDOM = null;
for (const seed of [
  `${process.cwd()}/package.json`,
  fileURLToPath(new URL('../frontend/package.json', import.meta.url)),
]) {
  try { ({ JSDOM } = createRequire(seed)('jsdom')); break; } catch { /* next */ }
}
if (!JSDOM) {
  console.log('SKIP: jsdom not found; install it in frontend to enable this check.');
  process.exit(0);
}

const code = readFileSync(
  new URL('../lse_terminal/ui/static/chart/chart.js', import.meta.url), 'utf8');
const dom = new JSDOM(
  '<!doctype html><html><body><div id="chart" style="width:900px;height:700px"></div><div id="replica" style="width:900px;height:700px"></div></body></html>',
  { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:7787/' },
);
const { window } = dom;
const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
window.matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
});
window.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(element) {
    this.callback([{ target: element, contentRect: { width: 900, height: 700 } }]);
  }
  unobserve() {}
  disconnect() {}
};
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 700,
    width: 900, height: 700, toJSON() {},
  };
};

function fakeCanvasContext(canvas) {
  const values = {
    canvas,
    measureText: (text) => ({ width: String(text).length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return new Proxy(values, {
    get(target, key) { return key in target ? target[key] : () => {}; },
    set(target, key, value) { target[key] = value; return true; },
  });
}
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return fakeCanvasContext(this);
};
window.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({}), text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(0),
});

window.localStorage.setItem('green-terminal.drawing-target.v1', 'both');
const modes = [];
const mirroredStates = [];
window.addEventListener('lset:drawing-mode', (event) => modes.push(event.detail));
window.addEventListener('lset:lse-drawing-state', (event) => mirroredStates.push(event.detail));
const script = window.document.createElement('script');
script.textContent = code;
window.document.body.appendChild(script);

try {
  await window.LSEChart.mount(window.document.getElementById('chart'), {
    provider: 'demo', symbol: 'BTCUSD', timeframe: '1h',
    candles: [
      { time: 1700000000000, open: 100, high: 102, low: 99, close: 101, volume: 10 },
      { time: 1700003600000, open: 101, high: 103, low: 100, close: 102, volume: 12 },
    ],
  });
  if (!window.LSEChartReplica) throw new Error('LSEChartReplica API is absent');
  await window.LSEChartReplica.attach(window.document.getElementById('replica'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!window.LSEChartReplica.mounted()) throw new Error('G-Flow replica did not mount');
  if (window.document.getElementById('replica').querySelectorAll('canvas').length === 0)
    throw new Error('G-Flow replica did not render the LSE chart engine');

  const target = [...window.document.querySelectorAll('button')]
    .find((button) => button.textContent.includes('TARGET'));
  if (!target) throw new Error('TARGET selector did not render');
  if (target.getAttribute('aria-pressed') !== 'true')
    throw new Error('persisted BOTH mode did not render selected');
  if (!target.textContent.includes('BOTH')) throw new Error('BOTH label is absent');
  if (target.textContent.includes('BOTH!')) throw new Error('mounted replica is not linked');

  target.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (target.getAttribute('aria-pressed') !== 'false')
    throw new Error('selector did not switch to ONE');
  if (!target.textContent.includes('ONE')) throw new Error('ONE label is absent');
  if (!modes.some((mode) => mode.mode === 'both' && mode.symbol === 'BTCUSD'))
    throw new Error(`BOTH bridge event is missing: ${JSON.stringify(modes)}`);
  if (!modes.some((mode) => mode.mode === 'one'))
    throw new Error(`ONE bridge event is missing: ${JSON.stringify(modes)}`);

  // Re-enter BOTH and prove the exact same-schema handshake completes. This
  // guards the stale-listener race where the replica received its snapshot
  // synchronously while it was still rendered in ONE mode.
  target.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (target.getAttribute('aria-pressed') !== 'true' || target.textContent.includes('BOTH!'))
    throw new Error('replica did not relink after ONE → BOTH');
  if (!mirroredStates.some((state) => state.source === 'primary' || state.source === 'gflow'))
    throw new Error('same-engine drawing snapshot handshake did not publish');

  const fatalErrors = errors.filter((error) => !error.includes('Not implemented'));
  if (fatalErrors.length) throw new Error(`page errors: ${fatalErrors.join(' | ')}`);

  console.log('PASS: exact LSE chart engine mounts on the G-Flow surface');
  console.log('PASS: TARGET selector renders persisted BOTH');
  console.log('PASS: TARGET selector toggles to ONE');
  console.log('PASS: mode bridge events carry the active symbol');

  // The dedicated G-Flow page has no visible primary chart, so the one unified
  // rail moves onto the replica there. The dock keeps it hidden because the
  // primary rail is already beside it.
  const replicaHost = window.document.getElementById('replica');
  await window.LSEChartReplica.attach(replicaHost, { showRail: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const replicaTarget = [...replicaHost.querySelectorAll('button')]
    .find((button) => button.textContent.includes('TARGET'));
  if (!replicaTarget) throw new Error('full-page G-Flow drawing rail is absent');
  let hiddenAncestor = false;
  for (let node = replicaTarget; node && node !== replicaHost; node = node.parentElement) {
    hiddenAncestor ||= node.style.display === 'none';
  }
  if (hiddenAncestor) throw new Error('full-page G-Flow drawing rail is hidden');
  console.log('PASS: full-page G-Flow exposes the unified drawing toolbar');

  window.LSEChartReplica.detach();
  if (window.document.getElementById('replica').childElementCount !== 0)
    throw new Error('G-Flow replica did not release its renderer');
  console.log('PASS: hidden G-Flow releases the second renderer');
  window.LSEChart.unmount();
  process.exit(0);
} catch (error) {
  console.error(`FAIL: ${error && error.stack || error}`);
  process.exit(1);
}
