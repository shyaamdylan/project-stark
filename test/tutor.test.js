const test = require('node:test');
const assert = require('node:assert');
const { ScreenObserver } = require('../src/observe');
const { Lesson, Tutor } = require('../src/tutor');

const el = (role, label, extra = {}) => ({ role, label, app: 'Acme', z: 0, x: 100, y: 100, w: 80, h: 24, ...extra });

test('the observer turns scans and clicks into what the user did', () => {
  let t = 1000;
  const o = new ScreenObserver({ now: () => t });
  const save = el('AXButton', 'Save', { x: 10, y: 10, w: 50, h: 20 });
  o.onScan({ app: 'Acme', window: 'Report', elements: [save, el('AXTextField', 'Title', { value: '' })] });
  t += 500;
  o.onScan({ app: 'Acme', window: 'Report', focused: { role: 'AXTextField', label: 'Title', value: 'Q' }, elements: [save, el('AXTextField', 'Title', { value: 'Q' })] });
  t += 500;
  o.onScan({ app: 'Acme', window: 'Report', focused: { role: 'AXTextField', label: 'Title', value: 'Q3' }, elements: [save, el('AXTextField', 'Title', { value: 'Q3' })] });
  t += 500;
  o.onClick(20, 15);
  t += 500;
  o.onScan({ app: 'Acme', window: 'Settings', elements: [] });
  const lines = o.since(0);
  assert.deepEqual(lines, ['put the cursor in field "Title"', 'changed field "Title" to "Q3"', 'clicked button "Save"', 'now in Acme — "Settings"']);
  assert.ok(lines.includes('changed field "Title" to "Q3"'), lines.join(' | '));
  assert.ok(!lines.includes('changed field "Title" to "Q"'), 'typing is one entry, not one per letter');
  assert.ok(lines.includes('clicked button "Save"'));
  assert.equal(lines[lines.length - 1], 'now in Acme — "Settings"');
});

const skill = {
  map: {
    title: 'Export a report',
    summary: '',
    steps: [
      { title: 'Open Export', action: 'Click Export.', event_ids: [1], is_judgment: false, reason: null, guardrails: [] },
      { title: 'Pick advanced mode', action: 'Turn on Advanced mode.', event_ids: [2], is_judgment: false, reason: null, guardrails: [] },
      { title: 'Set the depth', action: 'Choose Deep in Advanced settings.', event_ids: [3], is_judgment: false, reason: null, guardrails: [] },
      { title: 'Save', action: 'Click Save.', event_ids: [4], is_judgment: false, reason: null, guardrails: [] },
    ],
  },
  session: {
    events: [
      { id: 1, type: 'click', role: 'AXButton', label: 'Export' },
      { id: 2, type: 'click', role: 'AXCheckBox', label: 'Advanced mode' },
      { id: 3, type: 'click', role: 'AXButton', label: 'Deep' },
      { id: 4, type: 'click', role: 'AXButton', label: 'Save' },
    ],
  },
};

const exportBtn = el('AXButton', 'Export', { x: 10, y: 10, w: 60, h: 20 });
const prefs = el('AXButton', 'Preferences', { x: 200, y: 10, w: 80, h: 20 });
const save = el('AXButton', 'Save', { x: 300, y: 10, w: 60, h: 20 });

function lessonWith(turns, screen) {
  const emitted = [];
  const seen = [];
  const tutor = {
    turn: async (ctx) => {
      seen.push(ctx);
      const r = turns.shift();
      return { say: '', target: null, stepNumber: null, then: 'wait', skipSteps: [], status: 'continue', ...(typeof r === 'function' ? r(ctx) : r) };
    },
  };
  const lesson = new Lesson({ skill, scan: async () => screen(), emit: (s) => emitted.push(s), tutor, offPathDelayMs: 10, idleMs: 60000 });
  lesson.replay.loop = async () => {}; // drive scans by hand
  return { lesson, emitted, seen };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('on track, steps move on instantly with no tutor turn', async () => {
  const { lesson, emitted, seen } = lessonWith([], () => ({ app: 'Acme', window: 'Report', elements: [exportBtn, save] }));
  await lesson.start();
  assert.equal(emitted[0].say, 'Click Export.');
  lesson.onMouseDown(20, 15); // clicked Export
  await tick(200);
  lesson.stop();
  assert.equal(emitted[emitted.length - 1].stepNumber, 2);
  assert.equal(seen.length, 0);
});

test('a wrong click gets a correction, with what they actually did', async () => {
  const { lesson, emitted, seen } = lessonWith([{ say: 'That opened Preferences. Close it, then click Export.', then: 'wait' }], () => ({ app: 'Acme', window: 'Report', elements: [exportBtn, prefs] }));
  await lesson.start();
  lesson.onMouseDown(210, 15); // clicked Preferences
  await tick(80);
  lesson.stop();
  assert.equal(seen[0].trigger, 'off-path');
  assert.ok(seen[0].did.includes('clicked button "Preferences"'));
  const last = emitted[emitted.length - 1];
  assert.equal(last.say, 'That opened Preferences. Close it, then click Export.');
  assert.ok(last.chat);
});

test('a question is answered, and the lesson resumes at the step she says', async () => {
  const { lesson, emitted, seen } = lessonWith([{ say: 'About two minutes; three steps left. Now, click Export.', then: 'resume', stepNumber: 1 }], () => ({ app: 'Acme', window: 'Report', elements: [exportBtn] }));
  await lesson.start();
  lesson.onUserSays('how long is this going to take?');
  await tick(80);
  lesson.stop();
  assert.equal(seen[0].trigger, 'said');
  assert.equal(seen[0].detail, 'how long is this going to take?');
  const last = emitted[emitted.length - 1];
  assert.equal(last.say, 'About two minutes; three steps left. Now, click Export.');
  assert.equal(last.target.label, 'Export');
});

test('"I don\'t want advanced mode": those steps are skipped, never instructed', async () => {
  let screen = { app: 'Acme', window: 'Report', elements: [exportBtn, save] };
  const { lesson, emitted } = lessonWith([{ say: "No problem, we'll leave it off. Click Save.", then: 'resume', stepNumber: 4, skipSteps: [2, 3] }], () => screen);
  await lesson.start();
  lesson.onMouseDown(20, 15); // Export
  await tick(200);
  lesson.onUserSays("I don't want to use advanced mode");
  await tick(80);
  lesson.stop();
  const said = emitted.map((e) => e.say).filter(Boolean);
  assert.equal(said[said.length - 1], "No problem, we'll leave it off. Click Save.");
  assert.ok(!said.some((x) => /Deep/.test(x)), said.join(' | '));
  assert.equal(emitted[emitted.length - 1].stepNumber, 4);
});

test('going quiet gets a gentle check-in', async () => {
  const { lesson, seen } = lessonWith([{ say: 'Still with me? It is the Export button at the top.', then: 'wait' }], () => ({ app: 'Acme', window: 'Report', elements: [exportBtn] }));
  lesson.idleMs = 20;
  await lesson.start();
  await tick(40);
  lesson.checkIdle();
  await tick(30);
  lesson.stop();
  assert.equal(seen[0].trigger, 'idle');
});

test('the tutor gets the plan once, and only the latest screens', async () => {
  const sent = [];
  const reply = { say: 'ok', target_id: 0, step_number: 1, then: 'wait', skip_steps: [], status: 'continue' };
  const client = { beta: { messages: { create: async (req) => (sent.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }) } } };
  const tutor = new Tutor('k', skill, { client });
  const scan = { app: 'Acme', elements: [exportBtn] };
  const ctx = { trigger: 'said', detail: 'why?', did: ['clicked button "Export"'], where: 'Acme', lesson: { stepNumber: 1, totalSteps: 4, line: 'Click Export.' }, scan };
  const r = await tutor.turn(ctx);
  assert.equal(r.target.label, 'Export');
  await tutor.turn(ctx);
  await tutor.turn(ctx);
  const msgs = sent[2].messages;
  assert.match(msgs[0].content, /Lesson plan/);
  assert.match(msgs[0].content, /omitted/);
  assert.ok(!/Lesson plan/.test(msgs[4].content));
  assert.match(msgs[4].content, /They said: "why\?"/);
});
