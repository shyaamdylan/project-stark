const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the JXA scan script with the Mac bits stubbed, to test its window logic.
function load() {
  const ctx = { $: (x) => x, ObjC: { import() {}, bindFunction() {} }, Ref: () => [], console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/jxa/list-elements.js'), 'utf8'), ctx);
  return ctx;
}

const win = (pid, z, x, y, w, h, float = false) => ({ pid, name: `App${pid}`, z, x, y, w, h, float });

test('a strip an app draws over its own window is part of that window, not the front window', () => {
  const ctx = load();
  const axWindows = { 1: [{ pos: [0, 0], size: [1400, 900] }] };
  ctx.getAttr = (el, name) => (name === 'AXWindows' ? axWindows[el] : null);
  ctx.list = (x) => x || [];
  ctx.node = (x) => x;
  const strip = win(1, 0, 0, 0, 1400, 80);
  const main = win(1, 1, 0, 0, 1400, 900);
  const other = win(2, 2, 100, 100, 600, 400);
  const out = ctx.dropWindowParts([strip, main, other], (pid) => pid);
  assert.deepEqual(out.map((w) => [w.pid, w.h, w.z]), [[1, 900, 0], [2, 400, 1]]);
  assert.equal(ctx.frontWindow(out).h, 900);
});

test('a real second window of the same app is kept', () => {
  const ctx = load();
  const axWindows = { 1: [{ pos: [0, 0], size: [1400, 900] }, { pos: [200, 200], size: [400, 300] }] };
  ctx.getAttr = (el, name) => (name === 'AXWindows' ? axWindows[el] : null);
  ctx.list = (x) => x || [];
  ctx.node = (x) => x;
  const out = ctx.dropWindowParts([win(1, 0, 200, 200, 400, 300), win(1, 1, 0, 0, 1400, 900)], (pid) => pid);
  assert.equal(out.length, 2);
  assert.equal(ctx.frontWindow(out).h, 300);
});
