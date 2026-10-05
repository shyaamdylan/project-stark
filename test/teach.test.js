const test = require('node:test');
const assert = require('node:assert');
const { TeachSession } = require('../src/teach');

const field = (label, value, y = 100) => ({ role: 'AXTextField', label, value, app: 'Odoo', z: 0, x: 200, y, w: 160, h: 24 });
const button = (label, x = 600) => ({ role: 'AXButton', label, app: 'Odoo', z: 0, x, y: 40, w: 80, h: 28 });
const scanOf = (window, elements) => ({ app: 'Google Chrome', window, elements });

function makeSession(over = {}) {
  const asked = [];
  const s = new TeachSession({
    title: 'Code a supplier invoice',
    apprentice: {
      pickQuestion: async () => ({ ask: true, kind: 'why', question: 'Why move it to 0400?', event_ids: [2] }),
      draftMap: async () => ({ title: 'T', summary: 'S', steps: [], open_questions: ['Is there a limit?'], teach_back: "Here's how I understand it." }),
      finalizeMap: async ({ teachBackReply }) => ({ title: 'T', summary: 'S', steps: [], open_questions: [], teach_back: 'Final', reply: teachBackReply }),
      ...over.apprentice,
    },
    scan: async () => ({ error: 'unused' }),
    capture: async () => null,
    askUser: async (text, phase) => {
      asked.push({ text, phase });
      return phase === 'teach-back' ? 'yes' : 'Equipment over 5000 is capex.';
    },
    status: () => {},
  });
  s.running = true;
  return { s, asked };
}

test('a new window is a screen event; typing becomes one edit once the field settles', async () => {
  const { s } = makeSession();
  await s.tick(scanOf('Bill 4471', [field('Cost center', '4711')]));
  assert.equal(s.events[0].type, 'screen');

  // Typing over three ticks...
  await s.tick(scanOf('Bill 4471', [field('Cost center', '04')]));
  await s.tick(scanOf('Bill 4471', [field('Cost center', '040')]));
  await s.tick(scanOf('Bill 4471', [field('Cost center', '0400')]));
  assert.equal(s.events.length, 1, 'no edit while still typing');

  // ...then it stops changing.
  for (const p of s.pending.values()) p.lastAt -= 2000;
  await s.tick(scanOf('Bill 4471', [field('Cost center', '0400')]));
  const edit = s.events[1];
  assert.equal(edit.type, 'edit');
  assert.equal(edit.label, 'Cost center');
  assert.equal(edit.from, '4711');
  assert.equal(edit.to, '0400');
});

test('many fields changing at once is a new record, not a pile of edits', async () => {
  const { s } = makeSession();
  const rec = (n) => [1, 2, 3, 4, 5, 6].map((i) => field(`F${i}`, `${n}-${i}`, i * 30));
  await s.tick(scanOf('Bills', rec('a')));
  await s.tick(scanOf('Bills', rec('b')));
  assert.deepEqual(s.events.map((e) => e.type), ['screen', 'screen']);
  assert.match(s.events[1].fields, /F1: b-1/);
});

test('a click is matched to the smallest button under the pointer in the previous scan', async () => {
  const { s } = makeSession();
  const big = { role: 'AXRow', label: 'Invoice 4471 row', app: 'Odoo', z: 0, x: 0, y: 0, w: 1000, h: 200 };
  await s.tick(scanOf('Bill 4471', [big, button('Hold', 600)]));
  s.onMouseDown(620, 50);
  await new Promise((r) => setImmediate(r));
  const click = s.events.find((e) => e.type === 'click');
  assert.equal(click.label, 'Hold');
});

test('questions wait for a pause, then the answer is recorded', async () => {
  const { s, asked } = makeSession();
  await s.tick(scanOf('Bill 4471', [field('Cost center', '4711')]));
  await s.tick(scanOf('Bill 4471', [field('Cost center', '0400')]));
  for (const p of s.pending.values()) p.lastAt = 0;
  await s.flushEdits(false);

  s.lastInputAt = Date.now(); // still busy
  await s.maybeAsk();
  assert.equal(asked.length, 0);

  s.lastInputAt = Date.now() - 10000; // paused
  s.lastEventAt = Date.now() - 10000;
  await s.maybeAsk();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].phase, 'live');
  assert.equal(s.qas[0].answer, 'Equipment over 5000 is capex.');
});

test('finishing runs the debrief, the teach-back and the final map', async () => {
  const { s, asked } = makeSession();
  const map = await s.finish();
  assert.deepEqual(asked.map((a) => a.phase), ['debrief 1/1', 'teach-back']);
  assert.equal(map.reply, 'yes');
  assert.equal(map.confirmed, true);
  assert.equal(s.running, false);
});

test('narration is recorded; spoken commands are recognised, not recorded', () => {
  const { s } = makeSession();
  assert.equal(s.onNarration('This supplier always double-bills in December.'), null);
  assert.equal(s.events.at(-1).type, 'say');
  assert.equal(s.onNarration("Okay, I'm done."), 'finish');
  assert.equal(s.onNarration('That is off the record.'), 'off');
  assert.equal(s.onNarration("Right, we're back on the record"), 'on');
  assert.equal(s.events.filter((e) => e.type === 'say').length, 1);
});

test('no question while the expert is talking', async () => {
  const { s, asked } = makeSession();
  await s.tick(scanOf('Bill', [field('Cost center', '4711')]));
  await s.tick(scanOf('Bill', [field('Cost center', '0400')]));
  for (const p of s.pending.values()) p.lastAt = 0;
  await s.flushEdits(false);
  s.onSpeaking(true);
  s.lastInputAt = Date.now() - 10000;
  s.lastEventAt = Date.now() - 10000;
  await s.maybeAsk();
  assert.equal(asked.length, 0);
});
