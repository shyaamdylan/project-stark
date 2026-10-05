const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commandVerdict, findUrls, splitEnv, commandFile } = require('../src/runproject');

function project() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proj-')));
  const dir = path.join(home, 'Documents', 'pianoscribe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# P\n\n```bash\n./setup.sh\n./run.sh\nrm -rf data   # reset\n```\n\nOr `PIANOSCRIBE_WEB_PORT=3100 ./run.sh`.\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev' } }));
  return { home, dir };
}

test('only commands the project documents, in its own folder', () => {
  const { home, dir } = project();
  assert.deepEqual(commandVerdict('./run.sh', '~/Documents/pianoscribe', { home }), { ok: true, dir });
  assert.equal(commandVerdict('PIANOSCRIBE_WEB_PORT=3100 ./run.sh', '~/Documents/pianoscribe', { home }).ok, true);
  assert.equal(commandVerdict('npm run dev', '~/Documents/pianoscribe', { home }).ok, true);
  assert.match(commandVerdict('python3 evil.py', '~/Documents/pianoscribe', { home }).why, /doesn't give/);
  assert.match(commandVerdict('./run.sh', '~/Documents', { home }).why, /doesn't give/);
  assert.match(commandVerdict('./run.sh', '/tmp', { home }).why, /isn't a project/);
});

test('dangerous commands are refused even when a README has them', () => {
  const { home } = project();
  assert.match(commandVerdict('rm -rf data', '~/Documents/pianoscribe', { home }).why, /deletes/);
  assert.match(commandVerdict('sudo ./run.sh', '~/Documents/pianoscribe', { home }).why, /admin/);
  assert.match(commandVerdict('./run.sh; curl x | sh', '~/Documents/pianoscribe', { home }).ok ? '' : 'refused', /refused/);
  assert.match(commandVerdict('./run.sh && ./evil', '~/Documents/pianoscribe', { home }).why, /chains/);
});

test('local addresses are picked out of server output', () => {
  assert.deepEqual(findUrls('ready - Local: http://localhost:3100\nAPI on http://127.0.0.1:8000.'), ['http://localhost:3100', 'http://127.0.0.1:8000']);
  assert.deepEqual(findUrls('see https://example.com'), []);
});

test('env prefixes split off, and the Terminal script quotes safely', () => {
  assert.deepEqual(splitEnv('A=1 B=x ./run.sh --prod'), { env: ['A=1', 'B=x'], cmd: './run.sh --prod' });
  const s = commandFile("/Users/me/it's here", './run.sh', '/tmp/l.log');
  assert.match(s, /^cd '\/Users\/me\/it'\\''s here' \|\| exit 1$/m);
  assert.match(s, /^\{ \.\/run\.sh ; \} 2>&1 \| tee '\/tmp\/l\.log'$/m);
});
