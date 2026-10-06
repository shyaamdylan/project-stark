const test = require('node:test');
const assert = require('node:assert');
const { Guide, describeScreen, describeSkill } = require('../src/guide');

const scan = {
  app: 'Finder',
  elements: [
    { role: 'AXButton', label: 'Share', app: 'Finder', z: 0, x: 900, y: 40, w: 30, h: 24 },
    { role: 'AXMenuBarItem', label: 'File', app: 'Finder', z: 0, x: 110, y: 0, w: 42, h: 24 },
    { role: 'AXStaticText', label: 'x'.repeat(200), app: 'Finder', z: 0, x: 10, y: 300, w: 400, h: 80 },
    { role: 'AXButton', label: 'Back', app: 'Safari', z: 1, x: 20, y: 40, w: 24, h: 24 },
  ],
};

// A skill learned from an expert: two steps, one a judgment call.
const skill = {
  id: 'new-folder',
  map: {
    title: 'Make a project folder',
    summary: 'How to make a new folder for a project.',
    steps: [
      { title: 'Open the File menu', action: 'Click File in the menu bar.', event_ids: [1], is_judgment: false, decision: null, reason: null, rule: null, guardrails: [] },
      {
        title: 'Name it by client', action: 'Choose New Folder and name it.', event_ids: [2], is_judgment: true,
        decision: 'Named it "ACME 2026"', reason: 'Client name then year, so they sort together.', rule: 'Folder names: client then year',
        guardrails: [{ kind: 'stop_and_ask', text: 'New client? Ask the account manager first.', qa_id: null }],
      },
    ],
  },
  session: {
    events: [
      { id: 1, t: 1000, type: 'click', role: 'AXMenuBarItem', label: 'File' },
      { id: 2, t: 5000, type: 'edit', role: 'AXTextField', label: 'Name', from: 'untitled folder', to: 'ACME 2026' },
    ],
  },
};

// A Guide whose Claude client returns canned replies and records requests.
function fakeGuide(replies) {
  const g = new Guide('test-key', skill);
  g.requests = [];
  g.client = {
    beta: {
      messages: {
        create: async (body) => {
          g.requests.push(JSON.parse(JSON.stringify(body)));
          const reply = replies.shift();
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] };
        },
      },
    },
  };
  return g;
}

test('screen list keeps menus first, drops long text, front window before back', () => {
  const { chosen, text } = describeScreen(scan.elements);
  assert.deepEqual(chosen.map((e) => e.label), ['File', 'Share', 'Back']);
  assert.match(text, /^0 \| menu \| "File" \| Finder \| 110,0$/m);
  assert.match(text, /^2 \| button \| "Back" \| Safari \| 20,40$/m);
});

test('the Work Map is described with what the expert did, reasons and guardrails', () => {
  const text = describeSkill(skill);
  assert.match(text, /Step 1: Open the File menu/);
  assert.match(text, /clicked menu "File"/);
  assert.match(text, /Expert's reason: "Client name then year/);
  assert.match(text, /Guardrail \(stop and ask\): New client\?/);
  assert.match(text, /changed field "Name": "untitled folder" → "ACME 2026"/);
});

test('a step points at the element Claude picked, and the first turn carries the Work Map', async () => {
  const g = fakeGuide([{ status: 'step', step_number: 1, say: 'Open the File menu.', target_id: 0 }]);
  const step = await g.start('make a folder for a new project', scan);
  assert.equal(step.status, 'step');
  assert.equal(step.target.label, 'File');
  assert.equal(step.stepNumber, 1);
  assert.equal(g.totalSteps, 2);
  assert.equal(g.requests[0].model, 'claude-opus-5-5');
  assert.match(g.requests[0].messages[0].content, /Learned task: Make a project folder/);
  assert.match(g.requests[0].system[0].text, /Never invent steps/);
});

test('later turns append to the same conversation', async () => {
  const g = fakeGuide([
    { status: 'step', step_number: 1, say: 'Open the File menu.', target_id: 0 },
    { status: 'done', step_number: null, say: 'All set!', target_id: null },
  ]);
  await g.start('make a folder', scan);
  const step = await g.next(scan, 'Done.');
  assert.equal(step.status, 'done');
  assert.equal(step.target, null);
  assert.deepEqual(g.requests[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('an id that is not on screen still speaks, with nothing to point at', async () => {
  const g = fakeGuide([{ status: 'step', step_number: 2, say: 'Go back to Finder first.', target_id: 99 }]);
  const step = await g.start('make a folder', scan);
  assert.equal(step.status, 'step');
  assert.equal(step.target, null);
});

test('API errors come back with something to say, and history stays valid', async () => {
  const g = new Guide('test-key', skill);
  g.client = { beta: { messages: { create: async () => { throw new Error('boom'); } } } };
  await assert.rejects(g.start('anything', scan), (err) => typeof err.say === 'string');
  assert.equal(g.messages.length, 0);
});

test('a second turn while one is in flight is refused, not interleaved', async () => {
  const g = new Guide('test-key', skill);
  let release;
  g.client = {
    beta: {
      messages: {
        create: () => new Promise((r) => { release = () => r({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"status":"step","step_number":1,"say":"Hi","target_id":0}' }] }); }),
      },
    },
  };
  const first = g.start('goal', scan);
  await assert.rejects(g.next(scan, 'again'), (err) => err.busy === true);
  release();
  await first;
  assert.deepEqual(g.messages.map((m) => m.role), ['user', 'assistant']);
});

test('hidden dock items are listed and marked', () => {
  const { text } = describeScreen([
    { role: 'AXDockItem', label: 'Notes', app: 'Dock', z: 0, x: 400, y: 1117, w: 61, h: 77, hidden: true },
  ]);
  assert.match(text, /^0 \| dock item \| "Notes" \| Dock \| 400,1117 \(hidden\)$/m);
});

test('with a screenshot alongside, the screen list keeps what can be clicked and drops what the picture shows', () => {
  const { describeScreen } = require('../src/guide');
  const els = [
    { role: 'AXDockItem', label: 'Mail', app: 'Dock', x: 400, y: 880, w: 40, h: 40 },
    { role: 'AXButton', label: 'Save', app: 'Acme', x: 600, y: 40, w: 60, h: 24 },
    { role: 'AXButton', label: 'Behind', app: 'Other', x: 10, y: 10, w: 60, h: 24, hidden: true },
    { role: 'AXStaticText', label: 'A very long paragraph of text that the screenshot shows perfectly well already', app: 'Acme', x: 40, y: 200, w: 500, h: 40 },
    ...Array.from({ length: 300 }, (_, i) => ({ role: 'AXStaticText', label: `Row ${i}`, app: 'Acme', x: 40, y: 300 + i, w: 80, h: 18 })),
    { role: 'AXTextField', label: 'Cost center', app: 'Acme', x: 40, y: 900, w: 200, h: 30 },
  ];
  const full = describeScreen(els);
  const lean = describeScreen(els, { withPicture: true });
  const labels = lean.chosen.map((e) => e.label);
  assert.ok(labels.includes('Save') && labels.includes('Cost center'), 'everything clickable is kept');
  assert.ok(!labels.includes('Mail') && !labels.includes('Behind'), 'no Dock, nothing covered');
  assert.ok(!labels.some((l) => l.startsWith('A very long')), 'no paragraphs');
  assert.ok(lean.chosen.length <= 160);
  assert.ok(lean.text.length < full.text.length * 0.6, `${lean.text.length} vs ${full.text.length}`);
});
