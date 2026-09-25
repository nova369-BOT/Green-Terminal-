// Shell chrome contract: one product name, a real command palette, no
// internal engine brand in the waiting state. Run: node tests/shell_chrome.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const html = read("lse_terminal/ui/static/index.html");
const app = read("lse_terminal/ui/static/app.js");
const css = read("lse_terminal/ui/static/style.css");

assert.match(html, /<title>GREEN TERMINAL<\/title>/);
assert.match(html, /id="cmdk"/);
assert.match(html, /id="cmdk-open"/);
assert.match(html, /id="cmdk-input"/);
assert.match(html, /id="dw-profile"/);
assert.match(html, /WAITING FOR MARKET DATA/);
assert.doesNotMatch(html, /EdgeDepth/);
assert.doesNotMatch(html, /GATEWAY/);
assert.match(html, />G-FLOW</);
assert.match(html, />ENGINE</);
assert.doesNotMatch(html, /☀|🌙/);

assert.match(app, /const PRODUCT_NAME = "Green Terminal"/);
assert.match(app, /function setDocTitle/);
assert.match(app, /function setupCommandPalette/);
assert.match(app, /setupCommandPalette\(\)/);
// Developer comments may name the internal engine. User-facing copy must not.
assert.doesNotMatch(app, /separate optional feed/);
assert.doesNotMatch(app, /document\.title = [^;\n]*LSE Terminal/);
assert.doesNotMatch(app, /☀|🌙/);
assert.match(app, /eg\.reachable \? "LIVE" : "OFFLINE"/);

assert.match(css, /--rail-w:\s*78px/);
assert.match(css, /padding-left:\s*var\(--rail-w\)/);
assert.match(css, /#cmdk \{/);
assert.match(css, /#cmdk-open/);
assert.doesNotMatch(css, /font-size:\s*8px;\s*letter-spacing:\s*\.08em/);

const main = read("desktop/main.js");
assert.match(main, /Green Terminal\|LSE Terminal/);

assert.match(css, /#shot-btn/);
assert.match(css, /#ax \{/);
const shot = html.match(/<button id="shot-btn"[\s\S]*?<\/button>/);
assert.ok(shot, "camera control missing");
const shotInner = shot[0].replace(/^<button[^>]*>/, "").replace(/<\/button>$/, "");
assert.match(shotInner, /^<svg/);
assert.doesNotMatch(shotInner, />[^<]*[A-Za-z]/);
assert.match(html, /id="ax-open"/);
assert.match(html, /src="\.\/analysis\.js"/);
assert.doesNotMatch(app, /LSEQuantModels\.mount/);
assert.match(app, /typeof axOpen === "function"/);
const guide = read("lse_terminal/ui/static/guide.md");
assert.match(guide, /\*\*ANALYSIS\.\*\*/);
assert.doesNotMatch(guide, /Twenty interactive models/);
assert.doesNotMatch(guide, /diffusion simulator/);

console.log("shell chrome contract ok");
