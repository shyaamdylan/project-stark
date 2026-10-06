const test = require('node:test');
const assert = require('node:assert');
const { Replay, buildActions, lineFor } = require('../src/replay');

const skill = {
  map: {
    title: 'Code a supplier invoice',
    summary: '',
    steps: [
      { title: 'Open the bill', action: 'Open the next vendor bill.', event_ids: [1], is_judgment: false, reason: null, guardrails: [] },
      { title: 'Make a folder', action: 'Open the File menu and choose New Folder.', event_ids: [2, 3], is_judgment: false, reason: null, guardrails: [] },
      {
        title: 'Code it', action: 'Set the cost center.', event_ids: [4], is_judgment: true,
        reason: 'Equipment over five thousand euros is always capex.',
        guardrails: [{ kind: 'stop_and_ask', text: 'Unknown supplier: ask the controller.', qa_id: null }],
      },
    ],
  },
  session: {
    events: [
      { id: 1, type: 'click', role: 'AXRow', label: 'BILL/0042 Kraus' },
      { id: 2, type: 'click', role: 'AXMenuBarItem', label: 'File' },
      { id: 3, type: 'click', role: 'AXMenuItem', label: 'New Folder' },
      { id: 4, type: 'edit', role: 'AXTextField', label: 'Cost center', from: '4711', to: '0400' },
    ],
  },
};

const file = { role: 'AXMenuBarItem', label: 'File', app: 'Odoo', z: 0, x: 110, y: 0, w: 40, h: 24 };
const newFolder = { role: 'AXMenuItem', label: 'New Folder', app: 'Odoo', z: 0, x: 110, y: 30, w: 160, h: 22 };
const cost = (value) => ({ role: 'AXTextField', label: 'Cost center', value, app: 'Odoo', z: 0, x: 300, y: 200, w: 120, h: 24 });
const scanOf = (window, elements) => ({ app: 'Chrome', window, elements });

function makeReplay(screens, recover) {
  const emitted = [];
  let current = screens[0];
  const r = new Replay({
    skill,
    scan: async () => current,
    emit: (s) => emitted.push(s),
    recover: recover || (async () => ({ status: 'stuck', say: 'Lost.', target: null })),
  });
  r.running = true; // drive it by hand instead of the background loop
  r.latest = current;
  return { r, emitted, show: (s) => { current = s; } };
}

test('a Work Map becomes the expert\'s actions, step by step', () => {
  const acts = buildActions(skill);
  assert.deepEqual(acts.map((a) => [a.stepIndex, a.kind, a.label]), [
    [0, 'any-click', 'BILL/0042 Kraus'], // a specific record: any click will do
    [1, 'click', 'File'],
    [1, 'click', 'New Folder'],
    [2, 'edit', 'Cost center'],
  ]);
});

test('lines use the Work Map wording, with the expert\'s reason at judgment calls', () => {
  const acts = buildActions(skill);
  assert.equal(lineFor(acts[1], skill), 'Open the File menu and choose New Folder.');
  assert.equal(lineFor(acts[2], skill), 'Then choose New Folder.');
  assert.equal(lineFor(acts[3], skill), 'Set the cost center. Equipment over five thousand euros is always capex.');
});

test('clicking the target moves straight on; clicking elsewhere does not', async () => {
  const { r, emitted, show } = makeReplay([scanOf('Bills', [file])]);
  r.index = 1;
  r.point();
  assert.equal(emitted.at(-1).target.label, 'File');
  assert.equal(emitted.at(-1).stepNumber, 2);

  r.onMouseDown(900, 900); // not on File
  assert.equal(r.index, 1);

  show(scanOf('Bills', [file, newFolder])); // the menu opens
  r.onMouseDown(120, 10);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(r.index, 2);
  assert.equal(emitted.at(-1).target.label, 'New Folder');
  assert.equal(emitted.at(-1).say, 'Then choose New Folder.');
});

test('a target that shows up a moment later is pointed at quietly', () => {
  const { r, emitted } = makeReplay([scanOf('Bills', [file])]);
  r.index = 2; // New Folder, menu not open yet
  r.point();
  assert.equal(emitted.at(-1).target, null);
  r.onScan(scanOf('Bills', [file, newFolder]));
  assert.equal(emitted.at(-1).target.label, 'New Folder');
  assert.equal(emitted.at(-1).quietMove, true);
});

test('a field counts as done once its new value settles, then the skill finishes', async () => {
  const { r, emitted } = makeReplay([scanOf('Bill', [cost('4711')])]);
  r.index = 3;
  r.point();
  r.onScan(scanOf('Bill', [cost('04')]));
  r.onScan(scanOf('Bill', [cost('0400')]));
  assert.equal(r.index, 3, 'still typing');
  r.editSeenAt -= 2000;
  r.onScan(scanOf('Bill', [cost('0400')]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emitted.at(-1).status, 'done');
});

test('if the target never appears, Claude is asked where the user is', async () => {
  let asked = null;
  const { r, emitted } = makeReplay([scanOf('Somewhere else', [])], async (note) => {
    asked = note;
    return { status: 'step', say: 'Go back to the bill first.', target: null, stepNumber: 2 };
  });
  r.index = 1;
  r.point();
  r.lostSince -= 5000;
  r.onScan(scanOf('Somewhere else', []));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(asked, /can't see "File"/);
  assert.equal(emitted.at(-1).say, 'Go back to the bill first.');
  assert.equal(r.index, 1);
});

test("already past a step (what the next one needs just appeared): it moves on without waiting for the click", () => {
  const { r, emitted } = makeReplay([scanOf('Bills', [file])]);
  r.index = 1; // "click File"
  r.point();
  assert.equal(emitted.at(-1).target.label, 'File');
  // They opened the menu some other way (a shortcut, a click a little off): New Folder is showing.
  r.onScan(scanOf('Bills', [file, newFolder]));
  assert.equal(r.index, 2);
  assert.match(emitted.at(-1).say, /ahead of me/);
  assert.equal(emitted.at(-1).target.label, 'New Folder');
});

test("something already on screen when the step began isn't taken as being ahead", () => {
  const { r } = makeReplay([scanOf('Bills', [file, newFolder])]);
  r.index = 1;
  r.point();
  r.onScan(scanOf('Bills', [file, newFolder]));
  assert.equal(r.index, 1);
});

test('the thing pointed at moves (a scroll, a dragged window): the pointer follows it', () => {
  const { r, emitted } = makeReplay([scanOf('Bills', [file])]);
  r.index = 1;
  r.point();
  r.onScan(scanOf('Bills', [{ ...file, x: 300, y: 120 }]));
  assert.equal(r.index, 1);
  assert.equal(emitted.at(-1).quietMove, true);
  assert.deepEqual([emitted.at(-1).target.x, emitted.at(-1).target.y], [300, 120]);
});

const settle = async (r, value) => {
  r.onScan(scanOf('Bill', [cost(value)]));
  r.editSeenAt -= 2000;
  r.onScan(scanOf('Bill', [cost(value)]));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

test('a wrong decision at a judgment step is stopped, explained, and checked again once changed', async () => {
  const { r, emitted } = makeReplay([scanOf('Bill', [cost('')])]);
  const judged = [];
  r.judge = async (a, field) => {
    judged.push(field.value);
    return field.value === '0400' ? { ok: true } : { ok: false, say: 'Hold on, the expert would stop here: equipment over the limit is capex.' };
  };
  r.index = 3; // "Set the cost center" (a judgment call with a guardrail)
  r.point();
  await settle(r, '4711');
  assert.equal(r.index, 3, 'not moved on');
  assert.equal(emitted.at(-1).flagged, true);
  assert.match(emitted.at(-1).say, /would stop here/);
  // Same value again: no second check, no moving on.
  r.onScan(scanOf('Bill', [cost('4711')]));
  assert.deepEqual(judged, ['4711']);
  await settle(r, '0400');
  assert.deepEqual(judged, ['4711', '0400']);
  assert.equal(emitted.at(-1).status, 'done');
});

test('steps that are not decisions are never sent for checking', async () => {
  const plain = { ...skill, map: { ...skill.map, steps: skill.map.steps.map((st) => ({ ...st, is_judgment: false, guardrails: [] })) } };
  const emitted = [];
  let current = scanOf('Bill', [cost('')]);
  const r = new Replay({ skill: plain, scan: async () => current, emit: (x) => emitted.push(x), recover: async () => ({ status: 'stuck' }) });
  r.running = true;
  r.latest = current;
  r.judge = async () => assert.fail('should not judge');
  r.index = 3;
  r.point();
  await settle(r, '9999');
  assert.equal(emitted.at(-1).status, 'done');
});
