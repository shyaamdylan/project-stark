const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('the session log has the whole conversation, actions included, and keeps the last 20', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `session-2020-01-01-00-00-${String(i).padStart(2, '0')}.log`), '');
  const log = require('../src/sessionlog');
  const original = console.log;
  console.log = () => {}; // keep the test output quiet; the file still gets it
  const file = log.startSessionLog(dir);
  log.convo('You', 'where is the export button');
  log.convoFromReply({ ok: true, label: 'Export', say: 'There it is.' }, 'friday');
  log.convoFromSend('jarvis-state', { running: true, title: 'File a report' }, 'jarvis');
  log.convoFromSend('jarvis-step', { label: 'Save' }, 'jarvis');
  log.convo('You', '', '[skipped the question]');
  console.log = original;
  await new Promise((r) => setTimeout(r, 50));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /You: where is the export button/);
  assert.match(text, /Friday: There it is\. \[pointing at "Export"\]/);
  assert.match(text, /Jarvis: \[started: File a report\]/);
  assert.match(text, /Jarvis: \[pointing at "Save"\]/);
  assert.match(text, /You: \[skipped the question\]/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.log')).length, 20);
});
