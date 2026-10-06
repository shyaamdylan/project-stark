// Speech to text with ElevenLabs Scribe. The renderer cuts the microphone into
// utterances (it detects when you stop talking) and sends each one here as a
// WAV; we return the text.
//
// Speech in a language you don't speak to the assistant in is someone else in
// the room (or a video), so it's dropped: Scribe tells us the language and how
// sure it is. SPEECH_LANGUAGES lists yours (default English).
//
// Two exceptions. Checking for the name ({ forName }) and transcribing what
// follows it ({ forUs }) pin Scribe to your language and never drop: the name
// is the filter there, and with others talking in the room a clip that holds
// "Hey Friday" can still be judged the room's language as a whole.

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

// Scribe reports ISO 639-3 codes; people write the two-letter ones.
const THREE = { en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', nl: 'nld', hi: 'hin', ta: 'tam', te: 'tel', ml: 'mal', bn: 'ben', ur: 'urd', zh: 'zho', ja: 'jpn', ko: 'kor', ar: 'ara', ru: 'rus', el: 'ell', tr: 'tur', pl: 'pol', sv: 'swe' };
const code3 = (c) => {
  const s = String(c || '').trim().toLowerCase();
  return THREE[s] || s;
};

// Keep it, or drop it as someone else's speech? { keep, why }.
function judgeSpeech(body, languages = ['en']) {
  const text = String((body && body.text) || '').trim();
  if (!text) return { keep: false, text: '', why: 'nothing said' };
  const lang = code3(body.language_code);
  const sure = Number(body.language_probability || 0);
  const mine = languages.map(code3);
  if (lang && !mine.includes(lang) && sure >= 0.6) return { keep: false, text, why: `in another language (${lang})` };
  return { keep: true, text, why: '' };
}

// { text, others }: others is true when what was heard was dropped as someone
// else's speech (so the caller knows other people are talking nearby).
async function transcribe(wav, cfg, { forName = false, forUs = false } = {}) {
  if (!cfg.elevenLabs.apiKey) throw new Error('No ELEVENLABS_API_KEY');
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('tag_audio_events', 'false'); // no "(keyboard clicking)" for typing noises
  const languages = cfg.speechLanguages || ['en'];
  const pinned = forName || forUs;
  if (pinned) form.append('language_code', languages[0]);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  const res = await fetch(STT_URL, { method: 'POST', headers: { 'xi-api-key': cfg.elevenLabs.apiKey }, body: form });
  if (!res.ok) throw new Error(`Speech to text failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (pinned) return { text: String(body.text || '').trim(), others: false };
  const verdict = judgeSpeech(body, languages);
  if (!verdict.keep && verdict.text) console.log(`[mic] ignored ${JSON.stringify(verdict.text)}: ${verdict.why}`);
  return { text: verdict.keep ? verdict.text : '', others: !verdict.keep && Boolean(verdict.text) };
}

module.exports = { transcribe, judgeSpeech };
