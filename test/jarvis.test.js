const test = require('node:test');
const assert = require('node:assert');
const { JarvisRun, normalizePlan, riskOf, isSensitiveField, isSearchLikeField, isYes, sameValue } = require('../src/jarvis');
const { parseShortcut } = require('../src/act');
const { persona } = require('../src/persona');

const skill = {
  map: {
    title: 'Code a supplier invoice',
    summary: '',
    steps: [
      { title: 'New folder', action: 'Open File and choose New Folder.', event_ids: [], is_judgment: false, reason: null, guardrails: [] },
      { title: 'Code it', action: 'Set the cost center.', event_ids: [], is_judgment: true, reason: null, guardrails: [] },
      { title: 'Send it', action: 'Send it to approval.', event_ids: [], is_judgment: false, reason: null, guardrails: [] },
    ],
  },
  session: { events: [] },
};

const actions = [
  { stepIndex: 0, first: true, kind: 'click', role: 'AXMenuBarItem', label: 'File' },
  { stepIndex: 0, first: false, kind: 'click', role: 'AXMenuItem', label: 'New Folder' },
  { stepIndex: 1, first: true, kind: 'edit', role: 'AXTextField', label: 'Cost center', value: '0400' },
  { stepIndex: 2, first: true, kind: 'click', role: 'AXButton', label: 'Send' },
];

const plan = normalizePlan(
  {
    can_run: true,
    why_not: '',
    summary: "I'll code the invoice.",
    inputs: [{ id: 'i1', question: 'Which cost center?' }],
    actions: [
      { index: 0, value_from: 'none', input_id: null, confirm: false, confirm_line: '' },
      { index: 1, value_from: 'none', input_id: null, confirm: false, confirm_line: '' },
      { index: 2, value_from: 'input', input_id: 'i1', confirm: false, confirm_line: '' },
      { index: 3, value_from: 'none', input_id: null, confirm: false, confirm_line: '' },
    ],
    step_lines: ['Making a folder.', 'Coding it.', 'Sending it.'],
  },
  actions
);

const el = (role, label, extra = {}) => ({ role, label, app: 'Odoo', z: 0, x: 100, y: 100, w: 80, h: 24, ...extra });

// A fake screen that remembers what was typed into the focused field.
function harness({ answers = [], screen, run: opts = {} } = {}) {
  const calls = [];
  const asked = [];
  let typedInto = null;
  const fields = { 'Cost center': '4711' };
  const elements = () =>
    screen
      ? screen()
      : [el('AXMenuBarItem', 'File'), el('AXMenuItem', 'New Folder'), el('AXTextField', 'Cost center', { value: fields['Cost center'] }), el('AXButton', 'Send')];
  const run = new JarvisRun({
    skill,
    actions,
    plan,
    scan: async () => ({ app: 'Odoo', elements: elements() }),
    act: {
      click: async (r) => {
        calls.push(`click ${r.label}`);
        typedInto = r.label;
      },
      selectAll: async () => calls.push('selectAll'),
      type: async (t) => {
        calls.push(`type ${t}`);
        if (typedInto in fields) fields[typedInto] = t;
      },
      keys: async (k) => calls.push(`keys ${k.keyCode}`),
      escape: async () => calls.push('escape'),
    },
    ask: async (text, phase) => {
      asked.push({ text, phase });
      return answers.length ? answers.shift() : '';
    },
    wait: () => Promise.resolve(),
    findMs: 30,
    ...opts,
  });
  return { run, calls, asked };
}

test('asks for the case value, confirms, does the steps and checks before sending', async () => {
  const { run, calls, asked } = harness({ answers: ['0400', 'yes', 'yes, send it'] });
  const res = await run.run();
  assert.equal(res.status, 'done');
  assert.deepEqual(asked.map((a) => a.phase), ['jarvis-input', 'jarvis-confirm', 'jarvis-confirm']);
  assert.match(asked[2].text, /Send/);
  assert.deepEqual(calls, ['click File', 'click New Folder', 'click Cost center', 'selectAll', 'type 0400', 'click Send']);
});

test('does nothing at all without a yes', async () => {
  const { run, calls } = harness({ answers: ['0400', 'hmm, not yet'] });
  const res = await run.run();
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason, 'declined');
  assert.deepEqual(calls, []);
});

test('a no at the risky step stops before it', async () => {
  const { run, calls } = harness({ answers: ['0400', 'yes', 'no'] });
  const res = await run.run();
  assert.equal(res.status, 'stopped');
  assert.ok(!calls.includes('click Send'));
});

test('skipping a question stops him', async () => {
  const { run, calls } = harness({ answers: [''] });
  const res = await run.run();
  assert.equal(res.status, 'stopped');
  assert.deepEqual(calls, []);
});

test('the user clicking while he works stops him', async () => {
  const h = harness({ answers: ['0400', 'yes'] });
  h.run.emit = (ev) => {
    if (ev.type === 'point' && ev.target.label === 'Cost center') {
      h.run.actedAt = 0; // well after his last click
      h.run.onUserClick();
    }
  };
  const res = await h.run.run();
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason, 'user-click');
  assert.ok(!h.calls.some((c) => c.startsWith('type')));
});

test("his own clicks don't count as the user's", async () => {
  const h = harness({ answers: ['0400', 'yes', 'yes'] });
  const click = h.run.act.click;
  h.run.act.click = async (r) => {
    await click(r);
    h.run.onUserClick(); // arrives while acting
  };
  assert.equal((await h.run.run()).status, 'done');
});

test('helping with a hand-off takes more than one click: he waits out the episode', async () => {
  // A hand-off ("I can't find X, would you click it for me?") often needs the
  // user to do several clicks in a row (search, then pick a result) before
  // Jarvis's own next step can be found again. A click right after the one
  // that resolved the hand-off must not read as "you've taken over."
  const h = harness({
    answers: ['0400', 'yes', 'yes'],
    screen: () => [el('AXMenuBarItem', 'File'), el('AXTextField', 'Cost center', { value: '0400' }), el('AXButton', 'Send')],
  });
  let handoffs = 0;
  h.run.emit = (ev) => {
    if (ev.type === 'say') {
      handoffs++;
      setTimeout(() => {
        h.run.onUserClick(); // resolves the hand-off
        h.run.onUserClick(); // a second, unrelated click moments later: still helping
      }, 5);
    }
  };
  const res = await h.run.run();
  assert.equal(res.status, 'done');
  assert.ok(handoffs >= 1);
});

test('a click long after the last hand-off still stops him', async () => {
  const h = harness({ answers: ['0400', 'yes'] });
  h.run.emit = (ev) => {
    if (ev.type === 'point' && ev.target.label === 'Cost center') {
      h.run.actedAt = 0;
      h.run.assistUntil = 0; // no recent hand-off to be continuing
      h.run.onUserClick();
    }
  };
  const res = await h.run.run();
  assert.equal(res.status, 'stopped');
  assert.equal(res.reason, 'user-click');
});

test("can't find a button: asks the user to click it, then carries on", async () => {
  const h = harness({
    answers: ['0400', 'yes', 'yes'],
    screen: () => [el('AXMenuBarItem', 'File'), el('AXTextField', 'Cost center', { value: '0400' }), el('AXButton', 'Send')],
  });
  const said = [];
  h.run.emit = (ev) => {
    if (ev.type === 'say') {
      said.push(ev.say);
      setTimeout(() => h.run.onUserClick(), 5);
    }
  };
  const res = await h.run.run();
  assert.equal(res.status, 'done');
  assert.match(said[0], /New Folder/);
  assert.ok(!h.calls.includes('click New Folder'));
});

test('a search or address bar gets pressed Return, even if nobody taught that', async () => {
  // This is the literal sequence from the failed PianoScribe run: typing
  // "youtube.com" into Safari's address bar (reported as a plain AXTextField
  // labelled "smart search field") and then waiting for the "Search" field
  // on the next page, which never appears because nothing ever submitted
  // the address bar. Recording never captured a bare Return press (that's
  // the teaching-side fix), so the replay side must supply basic competence
  // on its own.
  const barActions = [{ stepIndex: 0, first: true, kind: 'edit', role: 'AXTextField', label: 'smart search field', value: 'youtube.com' }];
  const calls = [];
  const run = new JarvisRun({
    skill,
    actions: barActions,
    plan: normalizePlan({ can_run: true, summary: 'Go.', inputs: [], actions: [], step_lines: [] }, barActions),
    scan: async () => ({ elements: [el('AXTextField', 'smart search field', { value: 'youtube.com' })] }),
    act: {
      click: async () => calls.push('click'),
      selectAll: async () => calls.push('selectAll'),
      type: async (t) => calls.push(`type ${t}`),
      keys: async (k) => calls.push(`keys ${k.name}`),
      escape: async () => calls.push('escape'),
    },
    ask: async () => 'yes',
    wait: () => Promise.resolve(),
    findMs: 30,
  });
  assert.equal((await run.run()).status, 'done');
  assert.ok(calls.includes('keys Enter'), calls.join(', '));
});

test('a recorded Return after typing is not pressed twice', async () => {
  const barActions = [
    { stepIndex: 0, first: true, kind: 'edit', role: 'AXTextField', label: 'smart search field', value: 'youtube.com' },
    { stepIndex: 0, first: false, kind: 'shortcut', keys: 'Enter' },
  ];
  const calls = [];
  const run = new JarvisRun({
    skill,
    actions: barActions,
    plan: normalizePlan({ can_run: true, summary: 'Go.', inputs: [], actions: [], step_lines: [] }, barActions),
    scan: async () => ({ elements: [el('AXTextField', 'smart search field', { value: 'youtube.com' })] }),
    act: {
      click: async () => calls.push('click'),
      selectAll: async () => calls.push('selectAll'),
      type: async (t) => calls.push(`type ${t}`),
      keys: async (k) => calls.push(`keys ${k.name}`),
      escape: async () => calls.push('escape'),
    },
    ask: async () => 'yes',
    wait: () => Promise.resolve(),
    findMs: 30,
  });
  assert.equal((await run.run()).status, 'done');
  assert.equal(calls.filter((c) => c === 'keys Enter').length, 1, calls.join(', '));
});

test("something further down the page: he scrolls for it instead of giving up", async () => {
  // list-elements.js only reports what's currently in view (content scrolled
  // out of a list is skipped entirely, not merely marked hidden), so a video
  // a little further down a YouTube results page won't show up until Jarvis
  // scrolls -- exactly the gap in "basic computer use" that was reported.
  const findActions = [{ stepIndex: 0, first: true, kind: 'click', role: 'AXCell', label: 'Beneath Your Beautiful - piano cover' }];
  const calls = [];
  let scrolls = 0;
  const run = new JarvisRun({
    skill,
    actions: findActions,
    plan: normalizePlan({ can_run: true, summary: 'Go.', inputs: [], actions: [], step_lines: [] }, findActions),
    scan: async () => ({
      elements:
        scrolls >= 2
          ? [el('AXCell', 'Beneath Your Beautiful - piano cover', { x: 10, y: 400, w: 300, h: 80 })]
          : [el('AXCell', 'Some other video', { x: 10, y: 50, w: 300, h: 80 })],
    }),
    act: {
      click: async (r) => calls.push(`click ${r.label}`),
      scroll: async () => { scrolls++; calls.push('scroll'); },
      selectAll: async () => {},
      type: async () => {},
      keys: async () => {},
      escape: async () => {},
    },
    ask: async () => 'yes',
    wait: () => Promise.resolve(),
    findMs: 30000,
  });
  // Scroll kicks in after SCROLL_AFTER_MS of real time; make the fake clock skip ahead.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  run.waitFn = async (ms) => { offset += ms; };
  try {
    const res = await run.run();
    assert.equal(res.status, 'done');
  } finally {
    Date.now = realNow;
  }
  assert.ok(scrolls >= 2, `expected at least 2 scrolls, got ${scrolls}`);
  assert.ok(calls.includes('click Beneath Your Beautiful - piano cover'));
});

test('search-like fields, by role or label', () => {
  assert.ok(isSearchLikeField('AXSearchField', 'Search'));
  assert.ok(isSearchLikeField('AXTextField', 'smart search field'));
  assert.ok(isSearchLikeField('AXTextField', 'Search videos'));
  assert.ok(!isSearchLikeField('AXTextField', 'Cost center'));
});

test('never types into a password field', async () => {
  const pwActions = [{ stepIndex: 0, first: true, kind: 'edit', role: 'AXTextField', label: 'Password', value: 'hunter2' }];
  const typed = [];
  const run = new JarvisRun({
    skill,
    actions: pwActions,
    plan: normalizePlan({ can_run: true, summary: 'Sign in.', inputs: [], actions: [], step_lines: [] }, pwActions),
    scan: async () => ({ elements: [el('AXTextField', 'Password', { value: '' })] }),
    act: { click: async () => typed.push('click'), selectAll: async () => {}, type: async (t) => typed.push(t), keys: async () => {}, escape: async () => {} },
    ask: async (_t, phase) => (phase === 'jarvis-confirm' ? 'yes' : 'done'),
    wait: () => Promise.resolve(),
    findMs: 30,
  });
  assert.equal((await run.run()).status, 'done');
  assert.deepEqual(typed, []);
});

test('a skill Claude says needs a human is declined without asking anything', async () => {
  const asked = [];
  const run = new JarvisRun({
    skill,
    actions,
    plan: normalizePlan({ can_run: false, why_not: 'That needs your signature, sir.', actions: [] }, actions),
    scan: async () => ({ elements: [] }),
    act: {},
    ask: async (t) => asked.push(t),
  });
  const res = await run.run();
  assert.equal(res.status, 'declined');
  assert.equal(res.say, 'That needs your signature, sir.');
  assert.equal(asked.length, 0);
});

test('Esc stops him, but not the Esc he presses himself', () => {
  const { run } = harness();
  run.running = true;
  run.acting = true;
  run.onEscape();
  assert.ok(run.running);
  run.acting = false;
  run.actedAt = 0;
  run.onEscape();
  assert.ok(!run.running);
  assert.equal(run.stopReason, 'escape');
});

test('plans are made safe: one entry per action, bad input ids dropped', () => {
  const p = normalizePlan({ can_run: true, inputs: [{ id: 'i1', question: 'Which?' }], actions: [{ index: 2, value_from: 'input', input_id: 'nope', confirm: true, confirm_line: 'Sure?' }] }, actions);
  assert.equal(p.actions.length, actions.length);
  assert.equal(p.actions[2].value_from, 'recorded');
  assert.equal(p.actions[2].confirm, true);
  assert.equal(p.actions[0].value_from, 'none');
});

test('risky buttons and shortcuts', () => {
  assert.ok(riskOf({ kind: 'click', label: 'Send' }));
  assert.ok(riskOf({ kind: 'click', label: 'Move to Trash' }));
  assert.ok(riskOf({ kind: 'click', label: 'Pay now' }));
  assert.equal(riskOf({ kind: 'click', label: 'Save' }), null);
  assert.equal(riskOf({ kind: 'click', label: 'New Folder' }), null);
  assert.ok(riskOf({ kind: 'shortcut', keys: '⌘Q' }));
  assert.equal(riskOf({ kind: 'shortcut', keys: '⌘S' }), null);
});

test('sensitive fields', () => {
  for (const l of ['Password', 'Passcode', 'Card number', 'CVV', 'Verification code', 'API key']) assert.ok(isSensitiveField(l), l);
  for (const l of ['Cost center', 'Name', 'Amount']) assert.ok(!isSensitiveField(l), l);
});

test('only a clear yes is a yes', () => {
  for (const t of ['yes', 'Yeah.', 'go ahead', 'Proceed', 'do it', 'ok', 'Jarvis, yes']) assert.ok(isYes(t), t);
  for (const t of ['', 'no', 'wait', 'hmm', "yes but don't send it", 'not yet', 'stop']) assert.ok(!isYes(t), t);
});

test('a yes can lead with an interjection, not just the bare word', () => {
  // Real answers to "Shall I proceed?" rarely start with the bare affirmative
  // word. This is the literal line that got a live run wrongly declined.
  for (const t of ['Perfect. Go for it', 'Great, do it', 'Sounds good, go ahead', 'Brilliant, proceed'])
    assert.ok(isYes(t), t);
  for (const t of ['Perfect, but not that one', "Great, don't send it"]) assert.ok(!isYes(t), t);
});

test('field values compare loosely', () => {
  assert.ok(sameValue('1,000.00', '1000'));
  assert.ok(sameValue('0400', '0400'));
  assert.ok(sameValue('ACME GmbH', 'acme gmbh'));
  assert.ok(!sameValue('4711', '0400'));
});

test('shortcuts become key codes', () => {
  assert.deepEqual(parseShortcut('⇧⌘S'), { keyCode: 1, mods: ['shift down', 'command down'], name: 'S' });
  assert.deepEqual(parseShortcut('⌘Enter'), { keyCode: 36, mods: ['command down'], name: 'Enter' });
  assert.equal(parseShortcut('⌘Mystery'), null);
});

test('Jarvis addresses you as configured', () => {
  const cfg = { wakeWord: 'friday', jarvis: { address: 'sir', wakeWord: 'jarvis' } };
  assert.equal(persona('jarvis', cfg).s('Right away{sir}.'), 'Right away, sir.');
  assert.equal(persona('jarvis', { ...cfg, jarvis: { ...cfg.jarvis, address: '' } }).s('Right away{sir}.'), 'Right away.');
  assert.ok(persona('jarvis', cfg).fillers.every((f) => !f.includes('{')));
});

test('a stop before the run starts still counts', async () => {
  const { run, calls, asked } = harness({ answers: ['0400', 'yes', 'yes'] });
  run.stop('new-request');
  const res = await run.run();
  assert.equal(res.status, 'stopped');
  assert.equal(res.say, '');
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, []);
});
