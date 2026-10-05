const test = require('node:test');
const assert = require('node:assert');
const { normalizeRefined, cleanUrl, REFINE_VERSION } = require('../src/apprentice');
const { buildActions, Replay, atDestination } = require('../src/replay');
const { JarvisRun, normalizePlan } = require('../src/jarvis');
const { TeachSession } = require('../src/teach');

// The expert happened to be on Facebook, typed canva.com into the address bar,
// then made a design. The tidied map says "get to Canva", not "start on Facebook".
const events = [
  { id: 1, type: 'screen', app: 'Google Chrome', window: 'Facebook' },
  { id: 2, type: 'click', role: 'AXTextField', label: 'Address and search bar' },
  { id: 3, type: 'edit', role: 'AXTextField', label: 'Address and search bar', from: 'facebook.com', to: 'canva.com' },
  { id: 4, type: 'click', role: 'AXButton', label: 'Create a design' },
];
const original = {
  title: 'Make a Canva design',
  summary: 'From Facebook, go to Canva and make a design.',
  steps: [
    { title: 'Leave Facebook', action: 'Click the address bar on Facebook and type canva.com.', event_ids: [2, 3], is_judgment: false, decision: null, reason: null, reason_qa_id: null, reason_event_id: null, rule: null, guardrails: [] },
    { title: 'Create', action: 'Click Create a design.', event_ids: [4], is_judgment: false, decision: null, reason: null, reason_qa_id: null, reason_event_id: null, rule: null, guardrails: [] },
  ],
  open_questions: [],
  teach_back: "Here's how I understand it.",
  confirmed: true,
};
const claudeSays = {
  title: 'Make a Canva design',
  summary: 'Go to Canva and make a design.',
  steps: [
    { ...original.steps[0], title: 'Open Canva', action: 'Open canva.com in your browser; any tab is fine.', kind: 'go', destination: { name: 'Canva', url: 'canva.com', app: null }, inferred: false, event_ids: [2, 3, 99] },
    { ...original.steps[1], kind: 'do', destination: null, inferred: false },
  ],
  open_questions: [],
  teach_back: "Here's how I understand it.",
  prerequisites: ['Signed in to Canva'],
  cleanup_notes: ['Dropped starting on Facebook: you can open Canva from anywhere.'],
};

test('the tidied map keeps the destination, drops unknown events and marks the version', () => {
  const m = normalizeRefined(original, claudeSays, events);
  assert.equal(m.refined, REFINE_VERSION);
  assert.equal(m.steps[0].kind, 'go');
  assert.deepEqual(m.steps[0].destination, { name: 'Canva', url: 'https://canva.com/', app: null });
  assert.deepEqual(m.steps[0].event_ids, [2, 3]);
  assert.deepEqual(m.prerequisites, ['Signed in to Canva']);
  assert.equal(m.confirmed, true);
});

test('an empty answer leaves the original map alone', () => {
  const m = normalizeRefined(original, { steps: [] }, events);
  assert.equal(m.steps.length, 2);
  assert.equal(m.steps[0].title, 'Leave Facebook');
});

test('only web addresses are destinations', () => {
  assert.equal(cleanUrl('www.canva.com/design'), 'https://www.canva.com/design');
  assert.equal(cleanUrl('file:///etc/passwd'), null);
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl(''), null);
});

const skill = { map: normalizeRefined(original, claudeSays, events), session: { events } };

test('a "get to" step is one action, never the route through Facebook', () => {
  const acts = buildActions(skill);
  assert.deepEqual(acts.map((a) => a.kind), ['go', 'click']);
  assert.equal(acts[1].label, 'Create a design');
  // Same with a replay plan that tried to replay the address bar anyway.
  const planned = buildActions(skill, { actions: [{ step_number: 1, event_id: null, kind: 'go', say: 'Open Canva.' }, { step_number: 2, event_id: 4, kind: 'click', say: 'Click Create a design.' }] });
  assert.deepEqual(planned.map((a) => a.kind), ['go', 'click']);
});

test('arriving is recognised by address bar, window title or app', () => {
  const dest = { name: 'Canva', url: 'https://www.canva.com/', app: null };
  assert.ok(atDestination({ app: 'Safari', window: 'Home - Canva', elements: [] }, dest));
  assert.ok(atDestination({ app: 'Arc', window: '', elements: [{ role: 'AXTextField', label: 'Address', value: 'https://canva.com/' }] }, dest));
  assert.ok(!atDestination({ app: 'Google Chrome', window: 'Facebook', elements: [{ role: 'AXTextField', label: 'Address', value: 'facebook.com' }] }, dest));
  assert.ok(atDestination({ app: 'Notes', window: 'x', elements: [] }, { name: 'Notes', url: null, app: 'Notes' }));
});

const createBtn = { role: 'AXButton', label: 'Create a design', app: 'Chrome', z: 0, x: 10, y: 10, w: 80, h: 20 };

test('walkthrough: already on Canva, so the "get to" step is skipped silently', async () => {
  const emitted = [];
  const r = new Replay({ skill, scan: async () => ({ app: 'Chrome', window: 'Home - Canva', elements: [createBtn] }), emit: (s) => emitted.push(s) });
  r.loop = async () => {};
  await r.start();
  await new Promise((res) => setTimeout(res, 20));
  r.stop();
  assert.equal(emitted[0].say, 'Click Create a design.');
  assert.equal(emitted[0].stepNumber, 2);
});

test('walkthrough: from Facebook it says where to go, and moves on when Canva shows up', async () => {
  const emitted = [];
  let screen = { app: 'Chrome', window: 'Facebook', elements: [] };
  const r = new Replay({ skill, scan: async () => screen, emit: (s) => emitted.push(s) });
  r.loop = async () => {};
  await r.start();
  assert.equal(emitted[0].stepNumber, 1);
  assert.equal(emitted[0].target, null);
  screen = { app: 'Chrome', window: 'Canva', elements: [createBtn] };
  r.onScan(screen);
  await new Promise((res) => setTimeout(res, 20));
  r.stop();
  assert.equal(emitted[emitted.length - 1].stepNumber, 2);
});

test('Jarvis opens the site himself instead of retyping it on Facebook', async () => {
  const acts = buildActions(skill);
  let screen = { app: 'Chrome', window: 'Facebook', elements: [] };
  const did = [];
  const run = new JarvisRun({
    skill,
    actions: acts,
    plan: normalizePlan({ can_run: true, summary: 'Making a design.', inputs: [], actions: [], step_lines: [] }, acts),
    scan: async () => screen,
    act: {
      openUrl: async (u) => {
        did.push(`open ${u}`);
        screen = { app: 'Chrome', window: 'Canva', elements: [createBtn] };
      },
      click: async (r) => did.push(`click ${r.label}`),
    },
    ask: async () => 'yes',
    wait: () => Promise.resolve(),
    findMs: 30,
  });
  const res = await run.run();
  assert.equal(res.status, 'done');
  assert.deepEqual(did, ['open https://canva.com/', 'click Create a design']);
});

test('finishing a lesson runs the tidy-up, and a failed tidy-up keeps the lesson', async () => {
  const make = (refineMap) => {
    const s = new TeachSession({
      title: 'T',
      apprentice: {
        draftMap: async () => ({ title: 'T', summary: 'S', steps: [], open_questions: [], teach_back: 'tb' }),
        finalizeMap: async () => ({ title: 'T', summary: 'S', steps: [], open_questions: [], teach_back: 'tb' }),
        refineMap,
      },
      scan: async () => ({ error: 'unused' }),
      capture: async () => null,
      askUser: async () => 'yes',
      status: () => {},
    });
    s.running = true;
    return s;
  };
  const tidy = await make(async ({ map }) => ({ ...map, refined: 1, prerequisites: ['x'] })).finish();
  assert.deepEqual(tidy.prerequisites, ['x']);
  const kept = await make(async () => {
    throw new Error('offline');
  }).finish();
  assert.equal(kept.title, 'T');
  assert.equal(kept.confirmed, true);
});
