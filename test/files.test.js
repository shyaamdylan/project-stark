const test = require('node:test');
const assert = require('node:assert');
const { openVerdict, parseQuery, nameQuery, score, isClear } = require('../src/files');

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

test('spoken file requests become search words, types, folders and dates', () => {
  const q = (t) => {
    const r = parseQuery(t);
    return [r.words, r.exts, r.folder, r.sinceDays, r.newest, r.withApp, r.folderOnly];
  };
  assert.deepEqual(q('the Q3 budget spreadsheet'), [['q3', 'budget'], ['xls', 'xlsx', 'numbers', 'csv'], null, null, false, null, false]);
  assert.deepEqual(q('report.pdf'), [['report'], ['pdf'], null, null, false, null, false]);
  assert.deepEqual(q('my "evil*" notes'), [['evil', 'notes'], null, null, null, false, null, false]);
  assert.deepEqual(q('the pdf I downloaded yesterday'), [[], ['pdf'], 'Downloads', 2, false, null, false]);
  assert.deepEqual(q('my latest screenshot'), [['screenshot'], null, null, null, true, null, false]);
  assert.deepEqual(q('budget on my desktop in Numbers'), [['budget'], null, 'Desktop', null, false, 'Numbers', false]);
  assert.deepEqual(q('my downloads'), [[], null, 'Downloads', null, false, null, true]);
  assert.deepEqual(q('invoice from last week'), [['invoice'], null, null, 14, false, null, false]);
});

test('Spotlight queries only ever contain the words, never quotes or wildcards from the request', () => {
  assert.equal(nameQuery(['q3', 'bu"dg*et'], null), 'kMDItemDisplayName == "*q3*"cd && kMDItemDisplayName == "*budget*"cd');
  assert.match(nameQuery(['invoice'], 14), /\$time\.today\(-14\)/);
});

test('ranking prefers the closer name, then the more recent file', () => {
  const now = Date.now();
  const exact = score('/Users/tony/Documents/Budget.xlsx', ['budget'], { mtime: now - 400 * 86400000, home: '/Users/tony', now });
  const partial = score('/Users/tony/Documents/Old budget notes.txt', ['budget'], { mtime: now, home: '/Users/tony', now });
  assert.ok(exact > partial);
  const fresh = score('/Users/tony/Documents/Budget.xlsx', ['budget'], { mtime: now, home: '/Users/tony', now });
  assert.ok(fresh > exact);
});

test('a clear winner opens straight away; a close call is a question', () => {
  assert.ok(isClear([{ score: 1.05 }, { score: 0.9 }], 'budget'));
  assert.ok(!isClear([{ score: 0.95 }, { score: 0.93 }], 'budget'));
  assert.ok(isClear([{ score: 0.7 }, { score: 0.7 }], 'my latest screenshot'));
  assert.ok(isClear([{ score: 0.5, remembered: true }, { score: 0.9 }], 'budget'));
});
