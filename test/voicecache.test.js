const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('a short line is made once, then comes from disk on the next launch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  let calls = 0;
  global.fetch = async () => (calls++, new Response(Buffer.from('mp3-bytes'), { status: 200 }));
  const cfg = { voiceEnabled: true, elevenLabs: { apiKey: 'k', voiceId: 'v', modelId: 'eleven_v4_turbo' }, jarvis: { voiceId: 'j' } };
  let voice = require('../src/voice');
  voice.setDiskCache(dir);
  await voice.synthesize('Anytime!', cfg);
  assert.equal(calls, 1);
  // A fresh start: memory is empty, the disk isn't.
  delete require.cache[require.resolve('../src/voice')];
  voice = require('../src/voice');
  voice.setDiskCache(dir);
  const again = await voice.synthesize('Anytime!', cfg);
  assert.equal(calls, 1, 'not made again');
  assert.equal(String(again), 'mp3-bytes');
  // A long one-off answer isn't kept on disk.
  await voice.synthesize('This is a long answer about the invoice on screen that will probably never be said again word for word.', cfg);
  assert.equal(fs.readdirSync(dir).length, 1);
});
