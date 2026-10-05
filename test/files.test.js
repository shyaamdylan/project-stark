const test = require('node:test');
const assert = require('node:assert');
const { openVerdict, parseQuery } = require('../src/files');

const home = '/Users/tony';
const file = { isFile: true, isDirectory: false, mode: 0o644 };

test('documents in your home folder open', () => {
  assert.deepEqual(openVerdict('/Users/tony/Documents/Q3 Report.pdf', file, home), { ok: true, kind: 'file' });
  assert.equal(openVerdict('/Users/tony/Projects', { isDirectory: true }, home).kind, 'folder');
});

test('apps only launch from the Applications folders', () => {
  assert.equal(openVerdict('/Applications/Safari.app', { isDirectory: true }, home).ok, true);
  assert.equal(openVerdict('/System/Applications/Notes.app', { isDirectory: true }, home).ok, true);
  assert.equal(openVerdict('/Users/tony/Downloads/Totally Legit.app', { isDirectory: true }, home).why, 'app-outside-applications');
});

test('nothing that runs code', () => {
  for (const p of ['install.command', 'run.sh', 'Setup.pkg', 'thing.scpt', 'go.workflow', 'x.py', 'shortcut.webloc']) {
    assert.equal(openVerdict(`/Users/tony/Downloads/${p}`, file, home).why, 'runs-code', p);
  }
  assert.equal(openVerdict('/Users/tony/bin/tool', { isFile: true, mode: 0o755 }, home).why, 'runs-code');
});

test('nothing outside home, hidden or in Library', () => {
  assert.equal(openVerdict('/etc/hosts', file, home).why, 'outside');
  assert.equal(openVerdict('/Users/tony/.ssh/id_ed25519', file, home).why, 'hidden');
  assert.equal(openVerdict('/Users/tony/Library/Keychains/login.keychain-db', file, home).why, 'hidden');
  assert.equal(openVerdict('/Users/tonyx/notes.txt', file, home).why, 'outside');
});

test('spoken file requests become search words and types', () => {
  assert.deepEqual(parseQuery('the Q3 budget spreadsheet'), { words: ['q3', 'budget'], exts: ['xls', 'xlsx', 'numbers', 'csv'] });
  assert.deepEqual(parseQuery('report.pdf'), { words: ['report'], exts: ['pdf'] });
  assert.deepEqual(parseQuery('my "evil*" notes'), { words: ['evil', 'notes'], exts: null });
  assert.deepEqual(parseQuery('Safari'), { words: ['safari'], exts: null });
});
