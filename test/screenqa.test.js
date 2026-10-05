const test = require('node:test');
const assert = require('node:assert');
const { answerAboutScreen, isScreenQuestion } = require('../src/screenqa');
const { screenContext } = require('../src/observe');

test('questions about the screen are told apart from tasks and "where is" pointing', () => {
  for (const q of ['what does this do?', "what's this error mean", 'is this saved?', 'which one should I pick', 'explain this', 'summarise this', 'can you explain this page', 'should I tick this?', 'what am I looking at'])
    assert.ok(isScreenQuestion(q), q);
  for (const q of ['how do I export this', "where's the save button", "what's the way to rename a file", 'open the report', 'switch to mail'])
    assert.ok(!isScreenQuestion(q), q);
});

test('"this" is described as what is in front of them: window, file, field, selection', () => {
  const line = screenContext({
    app: 'Preview',
    window: 'report.pdf',
    document: '/Users/x/Documents/report.pdf',
    focused: { role: 'AXTextField', label: 'Search', value: 'q3' },
    selection: 'Net revenue rose 12%',
    elements: [],
  });
  assert.equal(line, 'Preview — "report.pdf"; the file open in it is /Users/x/Documents/report.pdf; typing in field "Search" (holds "q3"); selected text: "Net revenue rose 12%"');
});

const el = (role, label) => ({ role, label, app: 'Acme', z: 0, x: 10, y: 10, w: 50, h: 20 });

function fake(reply) {
  const sent = [];
  return { sent, beta: { messages: { create: async (req) => (sent.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }) } } };
}

test('a vague question is answered from the screen, pointing at what it is about', async () => {
  const client = fake({ kind: 'answer', say: 'Sync copies your changes to the cloud.', target_id: 0 });
  const scan = { app: 'Acme', window: 'Notes', selection: '', elements: [el('AXButton', 'Sync')] };
  const r = await answerAboutScreen('k', { question: 'what does this do?', scan, client });
  assert.equal(r.kind, 'answer');
  assert.equal(r.target.label, 'Sync');
  const msg = client.sent[0].messages[0].content;
  assert.match(msg, /What's in front of them: Acme — "Notes"/);
  assert.match(msg, /button \| "Sync"/);
  assert.match(client.sent[0].system, /assume it's about what's on their screen/);
});

test('a request to do something is handed back as a task', async () => {
  const r = await answerAboutScreen('k', { question: 'can you explain and then send this', scan: { app: 'Mail', elements: [] }, client: fake({ kind: 'task', say: '', target_id: null }) });
  assert.equal(r.kind, 'task');
});
