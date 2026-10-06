const test = require('node:test');
const assert = require('node:assert');
const { record, summary, costOf, labelFrom } = require('../src/usage');

test('cost counts cached tokens at the cache price', () => {
  const full = costOf('claude-opus-5-5', { input_tokens: 10000, output_tokens: 200 });
  const cached = costOf('claude-opus-5-5', { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 200 });
  assert.ok(Math.abs(full - (10000 * 4 + 200 * 20) / 1e6) < 1e-9);
  assert.ok(cached < full / 2);
});

test('each call is logged with its label, and the session adds up by label', () => {
  const lines = [];
  record('Tutor.turn', { model: 'claude-opus-5-5', usage: { input_tokens: 800, cache_read_input_tokens: 4000, output_tokens: 120 } }, (l) => lines.push(l));
  record('Tutor.turn', { model: 'claude-opus-5-5', usage: { input_tokens: 900, cache_read_input_tokens: 4100, output_tokens: 90 } }, (l) => lines.push(l));
  assert.match(lines[0], /Tutor\.turn: 4,800 in \(4,000 from cache\), 120 out/);
  assert.match(summary(), /Tutor\.turn\s+2 calls/);
});

test('the label is the function that made the call', () => {
  const stack = 'Error\n    at Messages.create (/app/src/usage.js:80:20)\n    at Tutor.turn (/app/src/tutor.js:226:41)\n    at async Lesson.ask (/app/src/tutor.js:400:10)';
  assert.equal(labelFrom(stack), 'Tutor.turn');
});
