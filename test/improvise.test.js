const test = require('node:test');
const assert = require('node:assert');
const { Improviser, ImprovisedWalkthrough } = require('../src/improvise');
const { JarvisFreestyle } = require('../src/jarvis');
const { spokenShortcut } = require('../src/act');

const el = (role, label, extra = {}) => ({ role, label, app: 'Safari', z: 0, x: 100, y: 100, w: 80, h: 24, ...extra });

// A brain that replays scripted turns and records what it was told.
function scripted(turns) {
  const notes = [];
  return {
    notes,
    next: async (note, scan) => {
      notes.push(note);
      const t = turns.shift();
      if (!t) throw new Error('out of script');
      return { summary: '', kind: 'none', target: null, text: null, say: '', ...(typeof t === 'function' ? t(scan) : t) };
    },
  };
}

function freestyle(turns, { answers = [], screen = () => ({ app: 'Safari', elements: [el('AXButton', 'Downloads'), el('AXButton', 'Send'), el('AXTextField', 'Password')] }) } = {}) {
  const did = [];
  const asked = [];
  const brain = scripted(turns);
  const run = new JarvisFreestyle({
    goal: 'show my downloads',
    improviser: brain,
    scan: async () => screen(),
    act: {
      click: async (r) => did.push(`click ${r.label}`),
      selectAll: async () => did.push('selectAll'),
      type: async (t) => did.push(`type ${t}`),
      keys: async (k) => did.push(`keys ${k.keyCode}`),
      openUrl: async (u) => did.push(`open ${u}`),
      openApp: async (n) => (did.push(`app ${n}`), n === 'Safari'),
    },
    ask: async (text, phase) => {
      asked.push({ text, phase });
      return answers.shift() || '';
    },
    wait: () => Promise.resolve(),
    findMs: 30,
  });
  return { run, did, asked, brain };
}

test('Jarvis: says what he will try and gets on with it, no "shall I?" for harmless steps', async () => {
  const said = [];
  const { run, did, asked } = freestyle([
    (s) => ({ status: 'step', kind: 'open_app', text: 'Safari', summary: "I'll open Safari and show your downloads.", say: 'Opening Safari.' }),
    (s) => ({ status: 'step', kind: 'click', target: s.elements[0], say: 'Downloads.' }),
    { status: 'done', say: 'There they are.' },
  ]);
  run.emit = (ev) => ev.say && said.push(ev.say);
  const res = await run.run();
  assert.equal(res.status, 'done');
  assert.equal(said[0], "I'll open Safari and show your downloads.");
  assert.deepEqual(asked, []);
  assert.deepEqual(did, ['app Safari', 'click Downloads']);
});

test('Jarvis: reads a file directly instead of off the screen, and gets its text next turn', async () => {
  const { run, brain } = freestyle([{ status: 'step', kind: 'read_file', text: '~/Documents/PianoScribe/README.md', say: 'Reading.' }, { status: 'done', say: 'Run npm install, then npm start.' }]);
  run.act.readFile = async (q) => ({ ok: true, path: '/Users/me/Documents/PianoScribe/README.md', folder: false, text: '## Run it\nnpm install\nnpm start' });
  const res = await run.run();
  assert.equal(res.status, 'done');
  assert.match(brain.notes[1], /npm start/);
});

test('Jarvis: never types or presses keys in a terminal', async () => {
  const { run, did, brain } = freestyle(
    [{ status: 'step', kind: 'type', text: 'npm start', say: 'Typing.' }, { status: 'step', kind: 'keys', text: 'Enter', say: 'Enter.' }, { status: 'done', say: 'Run npm start yourself.' }],
    { screen: () => ({ app: 'Terminal', elements: [] }) }
  );
  const res = await run.run();
  assert.equal(res.status, 'done');
  assert.deepEqual(did, []);
  assert.match(brain.notes[1], /don't type or press keys in a terminal/);
  assert.match(brain.notes[2], /don't type or press keys in a terminal/);
});

test('Jarvis: honest "needs teaching" at the start, before touching anything', async () => {
  const { run, did, asked } = freestyle([{ status: 'needs_teaching', say: "Your company's expense approval process isn't something I know." }]);
  const res = await run.run();
  assert.equal(res.status, 'needs_teaching');
  assert.match(res.say, /haven't been taught/);
  assert.match(res.say, /expense approval/);
  assert.deepEqual(did, []);
  assert.deepEqual(asked, []);
});

test('Jarvis: "needs teaching" halfway through stops there', async () => {
  const { run, did } = freestyle(
    [(s) => ({ status: 'step', kind: 'click', target: s.elements[0], say: 'Downloads.' }), { status: 'needs_teaching', say: "I don't know which folder your team files these in." }]
  );
  const res = await run.run();
  assert.equal(res.status, 'needs_teaching');
  assert.match(res.say, /stop there/);
  assert.deepEqual(did, ['click Downloads']);
});

test('Jarvis: risky clicks still need their own yes, and he never types a password', async () => {
  const { run, did } = freestyle(
    [
      (s) => ({ status: 'step', kind: 'type', target: s.elements[2], text: 'hunter2', say: 'Typing.' }),
      (s) => ({ status: 'step', kind: 'click', target: s.elements[1], say: 'Sending.' }),
    ],
    { answers: ['done', 'no'] }
  );
  const res = await run.run();
  assert.equal(res.status, 'stopped');
  assert.deepEqual(did, []);
});

test('Jarvis: asks for what only you know, then carries on with the answer', async () => {
  const { run, brain } = freestyle([{ status: 'need_info', say: 'What shall I call it?' }, { status: 'done', say: 'Done.' }], { answers: ['Budget'] });
  assert.equal((await run.run()).status, 'done');
  assert.match(brain.notes[1], /Budget/);
});

test('Jarvis: two failed actions in a row and he says it needs teaching', async () => {
  const { run } = freestyle([{ status: 'step', kind: 'open_app', text: 'Nope', say: 'Opening.' }, { status: 'step', kind: 'open_app', text: 'Nope', say: 'Opening.' }]);
  const res = await run.run();
  assert.equal(res.status, 'needs_teaching');
});

test('Friday: has a go, then admits when she is not sure', async () => {
  const steps = [];
  const brain = scripted([(s) => ({ status: 'step', kind: 'point', target: s.elements[0], say: 'Click Downloads.' }), { status: 'needs_teaching', say: "I don't know your team's filing rules." }]);
  const w = new ImprovisedWalkthrough({
    goal: 'file this invoice',
    brain,
    scan: async () => ({ app: 'Finder', elements: [el('AXButton', 'Downloads')] }),
    fingerprint: async () => 'same',
    emit: (s) => steps.push(s),
    ask: async () => '',
    pollMs: 5,
    idleMs: 10,
  });
  const done = w.start();
  await new Promise((r) => setTimeout(r, 20));
  w.onInput(); // they clicked
  await done;
  assert.equal(steps[0].status, 'step');
  assert.match(steps[0].say, /haven't been taught this, but let's give it a go/);
  assert.equal(steps[0].target.label, 'Downloads');
  assert.equal(steps[1].status, 'stuck');
  assert.match(steps[1].say, /not sure about the next part/);
  assert.match(steps[1].say, /let me show you/);
});

test('Friday: moves on when the screen changes, even without a click', async () => {
  const steps = [];
  let print = 'a';
  const brain = scripted([{ status: 'step', kind: 'none', say: 'Open Safari.' }, { status: 'done', say: "You're there." }]);
  const w = new ImprovisedWalkthrough({ goal: 'open safari', brain, scan: async () => ({ elements: [] }), fingerprint: async () => print, emit: (s) => steps.push(s), ask: async () => '', pollMs: 5, idleMs: 10 });
  const done = w.start();
  await new Promise((r) => setTimeout(r, 20));
  print = 'b';
  await done;
  assert.deepEqual(steps.map((s) => s.status), ['step', 'done']);
});

test('Improviser keeps only the latest screens in the conversation', async () => {
  const sent = [];
  const fake = {
    beta: {
      messages: {
        create: async (req) => {
          sent.push(req);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ status: 'step', say: 'Click it.', summary: '', action: { kind: 'point', target_id: 0, text: null } }) }] };
        },
      },
    },
  };
  const b = new Improviser('k', { mode: 'guide', client: fake });
  const scan = { app: 'Safari', elements: [el('AXButton', 'Go')] };
  const r = await b.next('The user asked: "x"', scan);
  assert.equal(r.target.label, 'Go');
  await b.next('next', scan);
  await b.next('next', scan);
  const last = sent[2].messages;
  assert.equal(last.length, 5);
  assert.match(last[0].content, /omitted/);
  assert.match(last[4].content, /On screen now/);
});

test('spoken key names', () => {
  assert.equal(spokenShortcut('command s'), '⌘S');
  assert.equal(spokenShortcut('cmd+shift+n'), '⇧⌘N');
  assert.equal(spokenShortcut('enter'), 'Enter');
  assert.equal(spokenShortcut('the down arrow'), 'ArrowDown');
  assert.equal(spokenShortcut('share'), null); // a button, not a key
  assert.equal(spokenShortcut('s'), null); // a bare letter would just type it
});

test('Jarvis: a project that is already running is not started again, unless asked twice', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  const dir = path.join(home, 'Documents', 'app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', test: 'jest' } }));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ran = [];
    let up = [{ command: 'node', port: 3100, folder: '~/Documents/app' }];
    const brain = scripted([
      { status: 'step', kind: 'run_command', text: 'npm run dev', folder: '~/Documents/app' },
      { status: 'step', kind: 'run_command', text: 'npm test', folder: '~/Documents/app' },
      { status: 'step', kind: 'run_command', text: 'npm test', folder: '~/Documents/app' },
      { status: 'done', say: 'Done.' },
    ]);
    const run = new JarvisFreestyle({
      goal: 'run my app',
      improviser: brain,
      scan: async () => ({ app: 'Finder', elements: [] }),
      act: {
        serversIn: async () => up,
        runCommand: async ({ command }) => (ran.push(command), { ok: true, finished: true, code: 0, output: 'ok', urls: [], servers: [] }),
      },
      ask: async () => 'yes',
      wait: () => Promise.resolve(),
    });
    const res = await run.run();
    assert.equal(res.status, 'done');
    assert.match(brain.notes[1], /Already running from this project: node on http:\/\/localhost:3100/);
    assert.match(brain.notes[2], /Already running/);
    assert.deepEqual(ran, ['npm test']); // dev was never started twice; tests ran once asked again
  } finally {
    process.env.HOME = oldHome;
  }
});
