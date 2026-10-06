const test = require('node:test');
const assert = require('node:assert');
const { forksOf, progress, decideForks } = require('../src/forks');
const { Replay } = require('../src/replay');
const { Lesson } = require('../src/tutor');
const { JarvisRun, normalizePlan } = require('../src/jarvis');

// A made-up task with a fork: steps 3 and 4 only belong to "a short version".
const step = (title, ids, only_if = null) => ({ title, action: `${title}.`, event_ids: ids, is_judgment: false, reason: null, guardrails: [], only_if });
const skill = {
  map: {
    title: 'Make a report',
    summary: '',
    steps: [step('Open Reports', [1]), step('Click Build', [2]), step('Click Shorten', [3], 'a short version'), step('Click Trim', [4], 'a short version'), step('Click Save', [5])],
  },
  session: { events: ['Reports', 'Build', 'Shorten', 'Trim', 'Save'].map((label, i) => ({ id: i + 1, type: 'click', role: 'AXButton', label })) },
};
const el = (label, x) => ({ role: 'AXButton', label, app: 'Acme', z: 0, x, y: 10, w: 50, h: 20 });
const all = ['Reports', 'Build', 'Shorten', 'Trim', 'Save'].map((l, i) => el(l, 10 + i * 100));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('the step count follows the path: an option not taken is not counted', () => {
  assert.deepEqual(forksOf(skill.map), [{ option: 'a short version', steps: [2, 3] }]);
  assert.deepEqual(progress(skill.map, 1), { n: 2, of: 3 }, 'before the fork: the path without the option');
  assert.deepEqual(progress(skill.map, 2), { n: 3, of: 5 }, 'offered the option: it counts while in front of them');
  assert.deepEqual(progress(skill.map, 4, { skipped: new Set([2, 3]) }), { n: 3, of: 3 });
  assert.deepEqual(progress(skill.map, 4, { chosen: new Set(['a short version']) }), { n: 5, of: 5 });
});

test('a lesson offers the option, and moving past it leaves the whole option out', async () => {
  const emitted = [];
  const r = new Replay({ skill, scan: async () => ({ app: 'Acme', window: 'R', elements: all }), emit: (s) => emitted.push(s) });
  r.loop = async () => {};
  await r.start();
  r.onMouseDown(15, 15); // Reports
  await tick(200);
  r.onMouseDown(115, 15); // Build
  await tick(200);
  assert.match(emitted.at(-1).say, /^Only if you want a short version: /);
  r.onMouseDown(415, 15); // straight to Save
  await tick(200);
  assert.deepEqual([...r.skipped].sort(), [2, 3]);
  assert.equal(emitted.at(-1).status, 'done');
  assert.deepEqual(r.shown(5), { shownStep: 3, shownTotal: 3 });
});

test('doing the option takes it, and its later steps are plain instructions', async () => {
  const emitted = [];
  const r = new Replay({ skill, scan: async () => ({ app: 'Acme', window: 'R', elements: all }), emit: (s) => emitted.push(s) });
  r.loop = async () => {};
  await r.start();
  r.index = 2;
  r.point();
  r.onMouseDown(215, 15); // Shorten
  await tick(200);
  assert.ok(r.chosen.has('a short version'));
  assert.equal(emitted.at(-1).say, 'Click Trim.');
  assert.deepEqual(r.shown(4), { shownStep: 4, shownTotal: 5 });
});

test('saying "skip" at an option leaves all of it out', async () => {
  const emitted = [];
  const lesson = new Lesson({ skill, scan: async () => ({ app: 'Acme', window: 'R', elements: all }), emit: (s) => emitted.push(s), tutor: { turn: async () => assert.fail('no tutor call needed') } });
  lesson.replay.loop = async () => {};
  await lesson.start();
  lesson.replay.index = 2;
  lesson.replay.point();
  lesson.onUserSays('skip that');
  await tick(30);
  lesson.stop();
  assert.equal(emitted.at(-1).stepNumber, 5);
  assert.equal(emitted.at(-1).shownStep, 3);
  assert.equal(emitted.at(-1).shownTotal, 3);
});

test('what they asked for can settle an option; a plain request asks nothing', async () => {
  let calls = 0;
  const client = { beta: { messages: { create: async (req) => {
    calls++;
    assert.match(req.messages[0].content, /- a short version/);
    return { content: [{ type: 'text', text: JSON.stringify({ options: [{ option: 'a short version', decision: 'take' }] }) }] };
  } } } };
  assert.equal((await decideForks({ client, map: skill.map, request: 'make the report, the short one' })).get('a short version'), 'take');
  assert.equal((await decideForks({ client, map: skill.map, request: '' })).get('a short version'), 'ask');
  assert.equal(calls, 1);
});

test('Jarvis leaves out an option not wanted, and asks about one the request did not settle', async () => {
  const actions = skill.map.steps.map((s, i) => ({ stepIndex: i, first: true, kind: 'click', role: 'AXButton', label: skill.session.events[i].label }));
  const plan = normalizePlan({ can_run: true, summary: 'Go.', inputs: [], actions: [], step_lines: [] }, actions);
  for (const [forks, answer, want] of [
    [new Map([['a short version', 'leave']]), null, ['Reports', 'Build', 'Save']],
    [new Map(), 'yes please', ['Reports', 'Build', 'Shorten', 'Trim', 'Save']],
    [new Map(), 'no', ['Reports', 'Build', 'Save']],
  ]) {
    const clicked = [];
    const asked = [];
    const steps = [];
    const run = new JarvisRun({
      skill, actions, plan, forks,
      scan: async () => ({ app: 'Acme', elements: all }),
      act: { click: async (r) => clicked.push(r.label) },
      ask: async (q) => (asked.push(q), /like a short version/.test(q) ? answer : 'yes'),
      emit: (e) => e.type === 'step' && steps.push(`${e.stepNo}/${e.totalSteps}`),
      wait: () => Promise.resolve(),
      findMs: 30,
    });
    const res = await run.run();
    assert.equal(res.status, 'done');
    assert.deepEqual(clicked, want);
    assert.equal(asked.some((q) => /short version/.test(q)), answer !== null);
    assert.equal(steps.at(-1), `${want.length}/${want.length}`);
  }
});
