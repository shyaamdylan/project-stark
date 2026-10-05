const test = require('node:test');
const assert = require('node:assert');
const { Improviser } = require('../src/improvise');
const { Tutor } = require('../src/tutor');
const { JarvisFreestyle } = require('../src/jarvis');
const { lookAtScreen } = require('../src/vision');

const el = (role, label, extra = {}) => ({ role, label, app: 'Acme', z: 0, x: 100, y: 100, w: 80, h: 24, ...extra });
const image = { data: 'SU1H', width: 1000, height: 800, frame: { x: 0, y: 0, w: 1000, h: 800 } };

function fake(reply) {
  const sent = [];
  return { sent, beta: { messages: { create: async (req) => (sent.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(typeof reply === 'function' ? reply() : reply) }] }) } } };
}

test('each best-effort turn sends the latest screenshot only', async () => {
  const client = fake({ status: 'step', say: 'Here.', summary: '', action: { kind: 'point', target_id: null, text: null, folder: null, point: { x: 500, y: 400, w: 100, h: 50, label: 'Heart' } } });
  const b = new Improviser('k', { mode: 'guide', client });
  const scan = { app: 'Acme', elements: [el('AXButton', 'Close')] };
  const r = await b.next('The user asked: "where is the heart"', scan, image);
  assert.deepEqual(r.point, { x: 500, y: 400, w: 100, h: 50, label: 'Heart' });
  await b.next('next', scan, image);
  const msgs = client.sent[1].messages;
  assert.equal(typeof msgs[0].content, 'string'); // the earlier screenshot was dropped
  assert.match(msgs[0].content, /screenshot from then omitted/);
  assert.equal(msgs[2].content[0].type, 'image');
});

test('the tutor can point at a spot only the screenshot shows', async () => {
  const skill = { map: { title: 'T', summary: '', steps: [{ title: 'S', action: 'Do it.', event_ids: [], is_judgment: false, reason: null, guardrails: [] }] }, session: { events: [] } };
  const client = fake({ say: 'That curve is the trend line.', target_id: null, point: { x: 200, y: 100, w: 100, h: 50, label: 'Trend line' }, step_number: 1, then: 'wait', skip_steps: [], status: 'continue' });
  const t = new Tutor('k', skill, { client });
  const r = await t.turn({ trigger: 'said', detail: 'what is that line?', did: [], where: 'Acme', lesson: { stepNumber: 1, totalSteps: 1, line: 'Do it.' }, scan: { app: 'Acme', elements: [] }, image });
  assert.deepEqual([Math.round(r.target.x), Math.round(r.target.y), r.target.label], [200, 100, 'Trend line']);
  assert.equal(client.sent[0].messages[0].content[0].type, 'image');
});

test('a screenshot answer prefers the exact element when the app describes it', async () => {
  const r = await lookAtScreen('k', { question: "where's save", image, scan: { app: 'Acme', elements: [el('AXButton', 'Save')] }, client: fake({ kind: 'answer', say: 'Top right.', target_id: 0, point: { x: 1, y: 1, w: 1, h: 1, label: 'x' } }) });
  assert.equal(r.target.label, 'Save');
  assert.equal(r.point, null);
});

function jarvis(screen, turns, answers = []) {
  const did = [];
  const said = [];
  const run = new JarvisFreestyle({
    goal: 'press the play button',
    improviser: { next: async () => turns.shift() },
    snap: async () => image,
    scan: async () => screen,
    act: { click: async (r) => did.push(`click ${r.label}`) },
    ask: async () => answers.shift() || '',
    emit: (ev) => ev.say && said.push(ev.say),
    wait: () => Promise.resolve(),
    findMs: 30,
  });
  return { run, did, said };
}

const step = (point) => ({ status: 'step', say: 'Playing.', summary: '', kind: 'click', target: null, point, text: null });

test('Jarvis clicks a spot found on the screenshot only when accessibility confirms a control there', async () => {
  const play = el('AXButton', 'Play', { x: 480, y: 380, w: 40, h: 40 });
  const { run, did } = jarvis({ app: 'Acme', elements: [play] }, [step({ x: 490, y: 390, w: 20, h: 20, label: 'play icon' }), { status: 'done', say: 'Playing.' }]);
  assert.equal((await run.run()).status, 'done');
  assert.deepEqual(did, ['click Play']);
});

test('nothing there to confirm: he points and asks you to click, never clicks a guess', async () => {
  const { run, did, said } = jarvis({ app: 'Acme', elements: [] }, [step({ x: 490, y: 390, w: 20, h: 20, label: 'play icon' }), { status: 'done', say: 'Playing.' }]);
  setTimeout(() => run.onUserClick(), 20);
  run.handoffClicked = true;
  const res = await run.run();
  assert.deepEqual(did, []);
  assert.ok(said.some((x) => /can't be sure of clicking it precisely/.test(x)), said.join(' | '));
  assert.equal(res.status, 'done');
});
