const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Organizer, makePlan, chooseKeep, parseSelection, tile, key } = require('../src/organize');

const area = { x: 0, y: 25, width: 1440, height: 850 };
const w = (app, title, index = 0, extra = {}) => ({
  app, title, pid: 100 + index, index, minimized: false, rect: { x: 30, y: 40, w: 800, h: 600 }, ...extra,
});

function service(windows, answer = 'no', opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'organize-test-'));
  const changes = [];
  const questions = [];
  const o = new Organizer({
    file: path.join(dir, 'layout.json'),
    inventory: async () => windows,
    change: async (op) => {
      changes.push(op);
      return {};
    },
    ask: async (q) => {
      questions.push(q);
      return answer;
    },
    area: () => area,
    ...opts,
  });
  return { o, changes, questions, cleanup: () => fs.rmSync(dir, { recursive: true }) };
}

test('calls and full-screen windows are never touched; terminals and documents are never closed', () => {
  const items = [
    w('Code', 'stark', 0, { frontmost: true }),
    w('Safari', 'News', 1),
    w('Terminal', 'build', 2),
    w('zoom.us', 'Zoom Meeting', 3),
    w('Google Chrome', 'Meet - standup', 4),
    w('TextEdit', 'Draft', 5, { edited: true }),
    w('Preview', 'Full', 6, { fullscreen: true }),
  ];
  const p = makePlan(items, [key(items[0])], area, { cleanup: true });
  assert.deepStrictEqual(p.closable.map((x) => x.title), ['News']);
  assert.deepStrictEqual(p.protected.map((x) => x.title).sort(), ['Full', 'Meet - standup', 'Zoom Meeting']);
  assert.deepStrictEqual(p.actions.filter((a) => a.kind === 'minimize').map((a) => a.window.title).sort(), ['Draft', 'build']);
});

test('tiles kept windows inside the screen, frontmost gets the big slot', () => {
  const items = [w('Safari', 'Docs', 1), w('Code', 'stark', 2, { frontmost: true }), w('Terminal', 'zsh', 3)];
  const p = makePlan(items, items.map(key), area);
  const frames = p.actions.filter((a) => a.kind === 'frame');
  assert.strictEqual(frames.length, 3);
  assert.strictEqual(frames.find((f) => f.window.app === 'Code').rect.h, area.height - 16);
  for (const f of frames) {
    assert.ok(f.rect.x >= area.x && f.rect.y >= area.y);
    assert.ok(f.rect.x + f.rect.w <= area.x + area.width && f.rect.y + f.rect.h <= area.y + area.height);
  }
  assert.strictEqual(tile(5, area).length, 5);
});

test('focus profiles and app names choose what stays', () => {
  const items = [w('Code', 'stark', 0), w('Terminal', 'zsh', 1), w('Slack', 'general', 2, { frontmost: true }), w('Safari', 'Docs', 3)];
  const coding = chooseKeep(items, 'coding');
  // Slack is frontmost but it's a distraction, so it doesn't sneak in.
  assert.deepStrictEqual(coding.sort(), [key(items[0]), key(items[1])].sort());
  assert.deepStrictEqual(chooseKeep(items, 'safari code').sort(), [key(items[0]), key(items[3])].sort());
  assert.deepStrictEqual(chooseKeep(items, ''), [key(items[2])]);
  assert.strictEqual(chooseKeep(items, 'gardening'), null);
});

test('parses one-shot answers', () => {
  assert.deepStrictEqual(parseSelection('yes', 3), [0, 1, 2]);
  assert.deepStrictEqual(parseSelection('no', 3), []);
  assert.deepStrictEqual(parseSelection('', 3), []);
  assert.deepStrictEqual(parseSelection('1 and 3', 3), [0, 2]);
  assert.deepStrictEqual(parseSelection('all but 2', 3), [0, 2]);
  assert.deepStrictEqual(parseSelection('9', 3), []);
  assert.deepStrictEqual(parseSelection('hmm maybe', 3), []);
});

test('organise never asks or closes, and undo restores the original geometry', async () => {
  const x = service([w('Code', 'stark', 0, { frontmost: true }), w('Safari', 'News', 1)]);
  const res = await x.o.run('organise workspace');
  assert.strictEqual(x.questions.length, 0);
  assert.ok(x.changes.every((c) => c.kind !== 'close'));
  assert.match(res.say, /undo/);
  await x.o.undo();
  const restores = x.changes.filter((c) => c.kind === 'restore');
  assert.strictEqual(restores.length, 2);
  assert.deepStrictEqual(restores[0].rect, { x: 30, y: 40, w: 800, h: 600 });
  assert.match((await x.o.undo()).say, /nothing to undo/i);
  x.cleanup();
});

test('cleanup asks exactly once; unpicked windows are minimised instead', async () => {
  for (const [answer, closed] of [['no', []], ['2', ['Downloads']], ['yes', ['News', 'Downloads']]]) {
    const x = service([w('Code', 'stark', 0, { frontmost: true }), w('Safari', 'News', 1), w('Finder', 'Downloads', 2)], answer);
    await x.o.run('clean up', { cleanup: true });
    assert.strictEqual(x.questions.length, 1);
    assert.match(x.questions[0], /1\. Safari — News\n2\. Finder — Downloads/);
    assert.deepStrictEqual(x.changes.filter((c) => c.kind === 'close').map((c) => c.window.title), closed);
    assert.strictEqual(x.changes.filter((c) => c.kind === 'minimize').length, 2 - closed.length);
    x.cleanup();
  }
});

test('a save dialog stops further closing without answering it', async () => {
  const x = service([w('Code', 'stark', 0, { frontmost: true }), w('Preview', 'A.pdf', 1), w('Preview', 'B.pdf', 2)], 'yes');
  x.o.change = async (op) => {
    x.changes.push(op);
    return { dialog: op.kind === 'close' };
  };
  const res = await x.o.run('clean up', { cleanup: true });
  assert.strictEqual(x.changes.filter((c) => c.kind === 'close').length, 1);
  assert.strictEqual(res.closed, 0);
  assert.match(res.say, /left that to you/);
  // The window that showed the dialog wasn't closed, so undo can still restore it.
  assert.ok(x.o.read().windows.every((s) => !s.closed));
  x.cleanup();
});

test('stop during the question changes nothing', async () => {
  let stopped = false;
  const x = service([w('Code', 'stark', 0, { frontmost: true }), w('Safari', 'News', 1)], 'yes');
  x.o.ask = async () => {
    stopped = true;
    return 'yes';
  };
  await assert.rejects(x.o.run('clean up', { cleanup: true, stopped: () => stopped }), { code: 'STOPPED' });
  assert.strictEqual(x.changes.length, 0);
  assert.strictEqual(x.o.read(), null);
  x.cleanup();
});

test('an unknown focus never minimises everything', async () => {
  const x = service([w('Viewer', 'Page', 0)]);
  await assert.rejects(x.o.run('organise for gardening', { focus: 'gardening' }), { code: 'NO-KEEP' });
  assert.strictEqual(x.changes.length, 0);
  x.cleanup();
});
