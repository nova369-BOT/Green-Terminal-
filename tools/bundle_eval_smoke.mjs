// Lightweight bundle-evaluation smoke: loads the built chart.js inside JSDOM
// (no real browser needed) and asserts it evaluates with zero errors and
// exposes the imperative API the shell relies on, including the new
// mountTimeframeSelector. This catches a crash introduced at module-eval time
// (bad import, top-level throw) without needing a headless Chromium.
//
// It complements tools/chart_smoke.mjs (which needs a real browser to prove a
// canvas actually paints). Run from anywhere that can resolve jsdom, e.g.:
//     cd frontend && node ../tools/bundle_eval_smoke.mjs
// Exit 0 = bundle evaluated and API present. Exit 1 = a real failure.
// Exit 0 with a SKIP notice = jsdom not installed (npm i jsdom to enable).
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Resolve jsdom from wherever the machine has it (the repo ships no browser
// deps of its own), same pattern chart_smoke.mjs uses for puppeteer-core.
let JSDOM = null;
for (const seed of [
  `${process.cwd()}/package.json`,
  fileURLToPath(new URL('../frontend/package.json', import.meta.url)),
].filter(Boolean)) {
  try { ({ JSDOM } = createRequire(seed)('jsdom')); break; } catch { /* next */ }
}
if (!JSDOM) {
  console.log('SKIP: jsdom not found; run `cd frontend && npm i jsdom` to enable this check.');
  process.exit(0);
}

const bundlePath = process.argv[2] || '../lse_terminal/ui/static/chart/chart.js';
const code = readFileSync(new URL(bundlePath, import.meta.url), 'utf8');


const errors = [];
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:7787/',
});
const { window } = dom;

// Stubs for browser APIs the bundle may touch at module-eval time.
window.matchMedia = window.matchMedia || (() => ({
  matches: false, addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
}));
window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
window.scrollTo = window.scrollTo || (() => {});
if (!window.HTMLCanvasElement.prototype.getContext) {
  window.HTMLCanvasElement.prototype.getContext = () => null;
}

window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const script = window.document.createElement('script');
script.textContent = code;
try {
  window.document.body.appendChild(script);
} catch (e) {
  errors.push('append/eval threw: ' + (e && e.stack || e));
}

const api = window.LSEChart;
const checks = [
  ['window.LSEChart is an object', api && typeof api === 'object'],
  ['LSEChart.mount is a function', api && typeof api.mount === 'function'],
  ['LSEChart.update is a function', api && typeof api.update === 'function'],
  ['LSEChart.mountLayoutButton is a function', api && typeof api.mountLayoutButton === 'function'],
  ['LSEChart.mountTimeframeSelector is a function', api && typeof api.mountTimeframeSelector === 'function'],
  ['LSEChart.layoutStore exists', api && !!api.layoutStore],
  ['zero eval/page errors', errors.length === 0],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`);
  if (!pass) ok = false;
}
if (errors.length) {
  console.log('--- errors ---');
  for (const e of errors) console.log(e);
}
process.exit(ok ? 0 : 1);
