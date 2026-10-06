const test = require('node:test');
const assert = require('node:assert');
const { transcribe } = require('../src/stt');

// Scribe stubbed: it hears a clip with other people talking and labels the
// whole thing as another language.
function stubScribe(reply) {
  const sent = [];
  const real = global.fetch;
  global.fetch = async (_url, { body }) => {
    sent.push(body);
    return { ok: true, json: async () => reply(body) };
  };
  return { sent, restore: () => { global.fetch = real; } };
}
const cfg = { elevenLabs: { apiKey: 'k' }, speechLanguages: ['en'] };
const wav = Buffer.from('RIFF');

test('the name check is pinned to your language and never dropped, so a busy room cannot hide the wake word', async () => {
  const s = stubScribe((form) => form.get('language_code')
    ? { text: 'Hey Friday, open the report', language_code: 'eng', language_probability: 0.9 }
    : { text: 'हे फ्राइडे ओपन द रिपोर्ट', language_code: 'hin', language_probability: 0.8 });
  try {
    for (const opts of [{ forName: true }, { forUs: true }]) {
      const r = await transcribe(wav, cfg, opts);
      assert.deepEqual(r, { text: 'Hey Friday, open the report', others: false });
    }
    assert.equal(s.sent[0].get('language_code'), 'en');
  } finally { s.restore(); }
});

test('ordinary speech in another language is dropped and reported as other people talking', async () => {
  const s = stubScribe(() => ({ text: 'Und dann?', language_code: 'deu', language_probability: 0.9 }));
  try {
    assert.deepEqual(await transcribe(wav, cfg), { text: '', others: true });
    assert.equal(s.sent[0].get('language_code'), null);
  } finally { s.restore(); }
  const t = stubScribe(() => ({ text: 'show me the nose', language_code: 'eng', language_probability: 0.95 }));
  try {
    assert.deepEqual(await transcribe(wav, cfg), { text: 'show me the nose', others: false });
  } finally { t.restore(); }
});
