const test = require('node:test');
const assert = require('node:assert');
const { needsVision, lookAtScreen, boxToScreen } = require('../src/vision');

const el = (role, label, extra = {}) => ({ role, label, app: 'Acme', z: 0, x: 0, y: 0, w: 40, h: 20, ...extra });
const busy = { app: 'Acme', window: 'Main', frame: { x: 0, y: 0, w: 1000, h: 800 }, elements: Array.from({ length: 20 }, (_, i) => el('AXButton', `B${i}`)) };

test('looks when the question is visual', () => {
  assert.ok(needsVision({ text: "where's the database in this diagram?", scan: busy }).need);
  assert.ok(needsVision({ text: 'which is the red one', scan: busy }).need);
  assert.ok(!needsVision({ text: "where's the export button", scan: busy }).need);
});

test('looks when the app describes almost nothing, or a big picture fills it', () => {
  const sparse = { ...busy, elements: [el('AXButton', 'Close')] };
  assert.match(needsVision({ text: 'what is this', scan: sparse }).why, /describes almost nothing/);
  const picture = { ...busy, elements: [...busy.elements, el('AXImage', 'architecture.png', { w: 900, h: 600 })] };
  assert.match(needsVision({ text: 'what is this', scan: picture }).why, /large picture/);
});

test('looks when accessibility came up empty, and for follow-ups in the same window', () => {
  assert.ok(needsVision({ text: 'where is the cache', scan: busy, missed: true }).need);
  const now = 1_000_000;
  const recent = { key: 'Acme|Main', at: now - 30_000 };
  assert.match(needsVision({ text: 'and what about that one', scan: busy, recent, now }).why, /still talking/);
  assert.ok(!needsVision({ text: 'and what about that one', scan: busy, recent: { ...recent, at: now - 10 * 60_000 }, now }).need);
  assert.ok(!needsVision({ text: 'and what about that one', scan: { ...busy, window: 'Other' }, recent, now }).need);
});

test('a box in screenshot pixels lands on the right place on screen, inside the window', () => {
  // A 1000x800-point window at (100, 50), sent as a 1568x1254 image.
  const r = boxToScreen({ x: 784, y: 627, w: 157, h: 63, label: 'Database' }, { width: 1568, height: 1254 }, { x: 100, y: 50, w: 1000, h: 800 });
  assert.equal(Math.round(r.x), 600);
  assert.equal(Math.round(r.y), 450);
  assert.equal(Math.round(r.w), 100);
  assert.equal(Math.round(r.h), 40);
  assert.equal(r.label, 'Database');
  const out = boxToScreen({ x: 5000, y: 5000, w: 10, h: 10, label: 'x' }, { width: 1000, height: 800 }, { x: 0, y: 0, w: 1000, h: 800 });
  assert.ok(out.x <= 1000 && out.y <= 800);
});

test('the screenshot is sent as an image with the question and its size', async () => {
  const sent = [];
  const client = { beta: { messages: { create: async (req) => (sent.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ kind: 'answer', say: "That's the cache.", point: { x: 10, y: 20, w: 30, h: 40, label: 'Cache' } }) }] }) } } };
  const r = await lookAtScreen('k', { question: "where's the cache?", image: { data: 'QUJD', width: 800, height: 600 }, scan: busy, client });
  assert.equal(r.point.label, 'Cache');
  const content = sent[0].messages[0].content;
  assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.match(content[1].text, /800×600 pixels/);
});
