// Readings are counts. These fixtures lock the rules in analysis.js.
// Run: node tests/analysis_math.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = fs.readFileSync(path.join(root, "lse_terminal/ui/static/analysis.js"), "utf8");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const ax = sandbox.window.GTAnalysis;
assert.ok(ax && ax.compute);

const breath = ax.compute("breath", [
  { open: 10, high: 11, low: 9, close: 10 },
  { open: 10, high: 12, low: 10, close: 11 },
  { open: 11, high: 13, low: 11, close: 12 },
  { open: 12, high: 14, low: 12, close: 13 },
  { open: 13, high: 13, low: 11, close: 12 },
  { open: 12, high: 12, low: 10, close: 11 },
  { open: 11, high: 13, low: 11, close: 12 },
  { open: 12, high: 14, low: 12, close: 13 },
  { open: 13, high: 15, low: 13, close: 14 },
  { open: 14, high: 16, low: 14, close: 15 },
]);
assert.match(breath.read, /open run is 4 rising/);
assert.equal(breath.figure.rows[0].n, 3);
assert.equal(breath.figure.rows[1].n, 3);
assert.equal(breath.figure.rows[1].value, null);
assert.equal(breath.figure.rows[2].n, 2);
assert.doesNotMatch(breath.read, /demo|simulated|sample price/i);

const flat = [];
for (let i = 0; i < 20; i++) {
  flat.push({
    open: 100, high: 101, low: 99, close: 100,
    time: Date.UTC(2024, 0, 1, i < 10 ? 0 : 5) ,
  });
}
// Quiet hours needs range that differs. Rebuild.
const hours = [];
for (let i = 0; i < 10; i++) {
  hours.push({ open: 10, high: 11, low: 10, close: 10.4, time: Date.UTC(2024, 0, 2, 0, i) });
}
for (let i = 0; i < 10; i++) {
  hours.push({ open: 10, high: 13, low: 10, close: 12, time: Date.UTC(2024, 0, 2, 5, i) });
}
const quiet = ax.compute("quiet", hours);
assert.match(quiet.read, /5:00 UTC held 75\.0%/);
assert.match(quiet.read, /even split of the 2 hours/);
assert.equal(quiet.figure.rows[5].loud, true);
assert.equal(quiet.figure.rows[0].share, 25);

const roomBars = [];
const tight = { open: 100, high: 100.5, low: 99.5, close: 100 };
const spike = { open: 100, high: 102, low: 99, close: 100 };
for (let i = 0; i < 8; i++) {
  roomBars.push(tight, spike);
}
for (let i = 0; i < 4; i++) roomBars.push(tight);
const room = ax.compute("room", roomBars);
assert.match(room.read, /Long 1× reached the target before the stop 0\.0%/);
assert.equal(room.figure.rows[0].value, 0);
assert.match(room.method, /counted as the stop/);

const late = [];
for (let k = 0; k < 8; k++) {
  late.push({ open: 10, high: 10, low: 9, close: 10 });
  late.push({ open: 10, high: 12, low: 10, close: 12 });
  for (let j = 0; j < 8; j++) late.push({ open: 12, high: 14, low: 12, close: 12 });
}
const waited = ax.compute("late", late);
assert.match(waited.read, /waiting one bar had already printed a median 100\.0%/);
assert.equal(waited.figure.groups[0].values[0], 100);

const empty = ax.compute("room", []);
assert.match(empty.read, /does not invent a series/);
assert.equal(empty.figure.kind, "none");

const names = ax.TOOLS.map((t) => t.id);
for (const id of ["room", "late", "breaks", "breath", "wound", "quiet", "weather", "rounds"]) {
  assert.ok(names.includes(id), id);
}
assert.equal(names.length, 8);

console.log("analysis math ok");
