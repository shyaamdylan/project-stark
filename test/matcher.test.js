const test = require('node:test');
const assert = require('node:assert');
const { parseQuery, findBest } = require('../src/matcher');

const screen = [
  { role: 'AXMenuBarItem', label: 'File', x: 60, y: 0, w: 40, h: 24 },
  { role: 'AXMenuBarItem', label: 'Edit', x: 100, y: 0, w: 40, h: 24 },
  { role: 'AXButton', label: 'Share', x: 900, y: 40, w: 60, h: 28 },
  { role: 'AXButton', label: 'Save Draft', x: 700, y: 600, w: 90, h: 28 },
  { role: 'AXButton', label: 'Send', x: 800, y: 600, w: 70, h: 28 },
  { role: 'AXSearchField', label: 'Search mail', x: 300, y: 40, w: 300, h: 28 },
  { role: 'AXTab', label: 'Settings', x: 120, y: 80, w: 80, h: 28 },
  { role: 'AXLink', label: 'Forgot password?', x: 400, y: 500, w: 120, h: 20 },
  { role: 'AXStaticText', label: 'Send feedback about this page to the team', x: 10, y: 900, w: 300, h: 20 },
  { role: 'AXCheckBox', label: 'Remember me', x: 400, y: 450, w: 120, h: 20 },
];

test('parseQuery strips filler and keeps role hints', () => {
  const q = parseQuery("Where's the share button?");
  assert.strictEqual(q.phrase, 'share');
  assert.ok(q.roleHints.has('AXButton'));
});

const cases = [
  ['share', 'Share'],
  ["where's the share button", 'Share'],
  ['send', 'Send'],
  ['save', 'Save Draft'],
  ['find the search box', 'Search mail'],
  ['settings tab', 'Settings'],
  ['forgot password', 'Forgot password?'],
  ['remember me checkbox', 'Remember me'],
  ['the file menu', 'File'],
  ['sned', 'Send'], // typo
  ['setings', 'Settings'], // typo
];

for (const [ask, expected] of cases) {
  test(`"${ask}" -> ${expected}`, () => {
    const r = findBest(ask, screen);
    assert.ok(r.match, `no match for "${ask}"`);
    assert.strictEqual(r.match.label, expected);
  });
}

test('nonsense returns no match but offers suggestions list', () => {
  const r = findBest('quantum flux capacitor', screen);
  assert.strictEqual(r.match, null);
  assert.ok(Array.isArray(r.suggestions));
});

test('empty request returns no match', () => {
  assert.strictEqual(findBest('the button please', screen).match, null);
});

test('hyphenated labels match the joined word, whatever the dash', () => {
  const items = [
    { role: 'AXMenuBarItem', label: 'Wi‑Fi, connected, 3 bars', x: 1500, y: 0, w: 30, h: 24, z: 0 },
    { role: 'AXMenuBarItem', label: 'Battery', x: 1540, y: 0, w: 30, h: 24, z: 0 },
  ];
  assert.equal(findBest('wifi', items).match.label, 'Wi‑Fi, connected, 3 bars');
  assert.equal(findBest('wi-fi', items).match.label, 'Wi‑Fi, connected, 3 bars');
});

test('equal matches prefer the window nearer the front', () => {
  const items = [
    { role: 'AXButton', label: 'Save', x: 10, y: 10, w: 40, h: 20, z: 2 },
    { role: 'AXButton', label: 'Save', x: 10, y: 500, w: 40, h: 20, z: 0 },
  ];
  assert.equal(findBest('save', items).match.z, 0);
});

test('suggestions are only things that sound like what was said', () => {
  const items = [
    { role: 'AXButton', label: 'Export', x: 0, y: 0, w: 10, h: 10 },
    { role: 'AXButton', label: 'Settings', x: 0, y: 20, w: 10, h: 10 },
    { role: 'AXButton', label: 'Share', x: 0, y: 40, w: 10, h: 10 },
    { role: 'AXButton', label: 'Help', x: 0, y: 60, w: 10, h: 10 },
  ];
  const r = findBest('expert', items); // misheard "export"
  assert.ok(!r.match || r.match.label === 'Export');
  for (const s of r.suggestions) assert.ok(['Export'].includes(s), `unrelated suggestion: ${s}`);
  const none = findBest('calendar', items);
  assert.deepEqual(none.suggestions, []);
});

test('sharing one word is not enough to be suggested', () => {
  const items = [
    { role: 'AXButton', label: 'More options for Local launch', x: 0, y: 0, w: 10, h: 10 },
    { role: 'AXButton', label: 'Local launch', x: 0, y: 20, w: 10, h: 10 },
  ];
  assert.deepEqual(findBest('rocket launch', items).suggestions, []);
});
