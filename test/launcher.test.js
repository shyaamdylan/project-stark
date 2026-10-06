const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../src/intent');
const { rank, describe, needsFiles, siteCandidates, shortDir } = require('../src/launcher');

const NOW = Date.parse('2026-10-06T12:00:00Z');
const world = [
  { type: 'window', app: 'Slack', title: 'general - Acme', pid: 1, index: 0 },
  { type: 'window', app: 'Preview', title: 'Q3 report.pdf', pid: 2, index: 0, document: 'file:///Users/me/Documents/Q3%20report.pdf' },
  { type: 'tab', app: 'Google Chrome', title: 'Inbox (3) - me@gmail.com', url: 'https://mail.google.com/mail/u/0', host: 'mail.google.com', window: 0, tabIndex: 2 },
  { type: 'app', name: 'Slack', path: '/Applications/Slack.app' },
  { type: 'app', name: 'Spotify', path: '/Applications/Spotify.app' },
  { type: 'app', name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app' },
  { type: 'project', name: 'project-stark', path: '/Users/me/Developer/project-stark' },
  { type: 'project', name: 'budget-api', path: '/Users/me/Developer/budget-api' },
  { type: 'file', name: 'Budget 2026.xlsx', path: '/Users/me/Documents/Finance/Budget 2026.xlsx', usedAt: NOW - 864e5 },
  { type: 'file', name: 'budget-notes.txt', path: '/Users/me/Documents/budget-notes.txt', usedAt: NOW - 400 * 864e5 },
  { type: 'file', name: 'Q3 report.pdf', path: '/Users/me/Documents/Q3 report.pdf', usedAt: NOW - 864e5 },
  ...siteCandidates(),
];
const pick = (text) => {
  const req = classify(text);
  const r = rank(req.kind === 'launch' ? req : req.fallback, world, NOW);
  return r.best && r.best.c;
};

test('switching prefers what is already open', () => {
  assert.strictEqual(pick('switch to slack').type, 'window');
  assert.strictEqual(pick('open slack').type, 'window');
  assert.strictEqual(pick('open spotify').type, 'app');
});

test('a named website reuses an open tab before opening a new one', () => {
  const c = pick('go to gmail');
  assert.strictEqual(c.type, 'tab');
  assert.strictEqual(pick('open youtube').type, 'site');
});

test('type words steer the choice', () => {
  assert.strictEqual(pick('open the budget spreadsheet').name, 'Budget 2026.xlsx');
  assert.strictEqual(pick('open the budget project').name, 'budget-api');
  assert.strictEqual(pick('open project stark').name, 'project-stark');
  // The PDF is already open in Preview, so switch to it.
  assert.strictEqual(pick('open Q3 report.pdf').type, 'window');
});

test('find reveals files rather than switching apps', () => {
  const req = classify('find my budget file');
  const r = rank(req, world, NOW);
  assert.strictEqual(r.best.c.name, 'Budget 2026.xlsx');
  assert.strictEqual(describe(req, r.best).action, 'reveal');
});

test('unknown things are not guessed', () => {
  assert.strictEqual(pick('open zebra quantum'), null);
});

test('file search only runs when it could matter', () => {
  assert.strictEqual(needsFiles(classify('switch to slack'), { score: 1.1 }), false);
  assert.strictEqual(needsFiles(classify('open the budget spreadsheet'), { score: 1.1 }), true);
  assert.strictEqual(needsFiles(classify('find invoice'), null), true);
});

test('shortDir keeps paths readable', () => {
  assert.strictEqual(shortDir('/Users/me/Documents/Finance/Budget.xlsx'), '~/Documents/Finance');
});
