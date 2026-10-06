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

test("Friday checks a filled-in decision against the expert's reasoning, and remembers stopping them", async () => {
  const decisionSkill = {
    map: {
      title: 'Code a supplier invoice',
      summary: 'Book each bill to a cost center.',
      steps: [{ title: 'Set the cost center', action: 'Choose the cost center.', event_ids: [], is_judgment: true, decision: 'Re-coded to capex', reason: 'Equipment over the limit is always capex.', rule: null, guardrails: [{ kind: 'stop_and_ask', text: 'Unknown supplier: ask the controller.', qa_id: null }] }],
    },
    session: { events: [], qas: [] },
  };
  const sent = [];
  const client = { beta: { messages: { create: async (req) => (sent.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ok: false, say: 'Hold on, the expert would stop here. This is equipment over the limit, so it goes to capex.', target_id: 0 }) }] }) } } };
  const t = new Tutor('k', decisionSkill, { client });
  const field = el('AXTextField', 'Cost center', { value: '4711' });
  const r = await t.judge({ stepNumber: 1, label: 'Cost center', value: '4711', expertValue: '0400', scan: { app: 'Acme', elements: [field] } });
  assert.equal(r.ok, false);
  assert.match(r.say, /would stop here/);
  assert.equal(r.target.label, 'Cost center');
  const prompt = sent[0].messages[0].content;
  for (const fact of ['Equipment over the limit is always capex.', 'The learner entered "4711"', 'The expert entered "0400"', 'Unknown supplier: ask the controller.']) assert.ok(prompt.includes(fact), fact);
  assert.equal(t.notes.length, 1, 'the next tutor turn hears about it');
});

test('Spotter: steps move on silently, a wrong click gets no comment, and a guardrail on this record is said before they act', async () => {
  const guarded = { ...skill, map: { ...skill.map, steps: skill.map.steps.map((st, i) => (i === 3 ? { ...st, guardrails: [{ kind: 'stop_and_ask', text: 'Unknown supplier: ask the controller first.', qa_id: null }] } : st)) } };
  const emitted = [];
  const seen = [];
  const concerns = [];
  const tutor = {
    turn: async (ctx) => (seen.push(ctx), { say: 'x', target: null, stepNumber: null, then: 'wait', skipSteps: [], status: 'continue' }),
    concern: async (ctx) => (concerns.push(ctx.stepNumber), { flag: true, say: "Before you save: this supplier isn't on the list. The expert would ask the controller first.", target: null }),
  };
  const lesson = new Lesson({ skill: guarded, scan: async () => ({ app: 'Acme', window: 'Report', elements: [exportBtn, prefs, save] }), emit: (s) => emitted.push(s), tutor, offPathDelayMs: 10, idleMs: 20, spot: true });
  lesson.replay.loop = async () => {};
  await lesson.start();
  assert.equal(emitted[0].say, '', 'no step instructions');
  assert.equal(emitted[0].target, null, 'no pointing');
  lesson.onMouseDown(210, 15); // a detour: Preferences
  await tick(120);
  assert.equal(seen.length, 0, 'no comments, no check-ins');
  // Through the steps to the one with a guardrail.
  lesson.replay.index = 3;
  lesson.replay.point();
  await tick(30);
  assert.deepEqual(concerns, [4]);
  const flag = emitted.find((e) => e.flagged);
  assert.match(flag.say, /ask the controller/);
  lesson.onMouseDown(310, 15); // Save
  await tick(200);
  lesson.stop();
  assert.equal(emitted.at(-1).status, 'done');
  assert.equal(emitted.at(-1).say, 'All done. I flagged one thing along the way.');
});
