const test = require('node:test');
const assert = require('node:assert');
const { classify, isStop } = require('../src/intent');

test('stop works with either wake word and on its own', () => {
  for (const t of ['stop', 'Jarvis stop', 'friday, stop listening', 'hey Jarvis, never mind', 'cancel', 'stop friday']) {
    assert.strictEqual(classify(t).kind, 'stop', t);
    assert.ok(isStop(t), t);
  }
  // "stop" inside a longer request is not a stop command.
  assert.notStrictEqual(classify('stop the timer').kind, 'stop');
});

test('workspace commands', () => {
  assert.deepStrictEqual(classify('organise my workspace for coding'), { kind: 'organize', cleanup: false, focus: 'coding' });
  assert.deepStrictEqual(classify('Jarvis, clean up my workspace'), { kind: 'organize', cleanup: true, focus: '' });
  assert.strictEqual(classify('close the irrelevant windows').cleanup, true);
  assert.strictEqual(classify('keep safari and code organised').focus, 'safari code');
  assert.strictEqual(classify('set up my coding workspace').focus, 'coding');
  assert.strictEqual(classify('undo').kind, 'undo');
  assert.strictEqual(classify('put it back').kind, 'undo');
});

test('switch, open, find and search pick the right mode', () => {
  assert.strictEqual(classify('switch to slack').mode, 'switch');
  assert.strictEqual(classify('go back to my email').mode, 'switch');
  const sheet = classify('open the budget spreadsheet');
  assert.strictEqual(sheet.mode, 'open');
  assert.strictEqual(sheet.query, 'budget');
  assert.ok(sheet.types.has('file') && sheet.extensions.has('xlsx'));
  const pdf = classify('find my tax return pdf');
  assert.strictEqual(pdf.mode, 'find');
  assert.strictEqual(pdf.query, 'tax return');
  const lit = classify('hey jarvis open Q3 report.pdf');
  assert.strictEqual(lit.query, 'q3 report');
  assert.ok(lit.extensions.has('pdf'));
  const proj = classify('open project stark');
  assert.ok(proj.types.has('project'));
  assert.strictEqual(proj.query, 'stark');
  const yt = classify('search youtube for lofi beats');
  assert.strictEqual(yt.mode, 'search');
  assert.strictEqual(yt.url, 'https://www.youtube.com/results?search_query=lofi%20beats');
  assert.strictEqual(classify('go to github.com').url, 'https://github.com');
  // Searching for a file is a file find, not a web search.
  assert.strictEqual(classify('search for the invoice file').mode, 'find');
});

test('UI controls still go to the pointer; ambiguous finds fall back to files', () => {
  assert.strictEqual(classify("where's the share button").kind, 'point');
  assert.strictEqual(classify("where's the share button").fallback, undefined);
  const bare = classify('share');
  assert.strictEqual(bare.kind, 'point');
  assert.strictEqual(bare.fallback.mode, 'open');
  const where = classify('where did i put the invoice');
  assert.strictEqual(where.kind, 'point');
  assert.strictEqual(where.fallback.mode, 'find');
});
