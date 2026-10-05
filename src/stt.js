// Speech to text with ElevenLabs Scribe. The renderer cuts the microphone into
// utterances (it detects when you stop talking) and sends each one here as a
// WAV; we return the text.

const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

async function transcribe(wav, cfg) {
  if (!cfg.elevenLabs.apiKey) throw new Error('No ELEVENLABS_API_KEY');
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('tag_audio_events', 'false'); // no "(keyboard clicking)" for typing noises
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  const res = await fetch(STT_URL, { method: 'POST', headers: { 'xi-api-key': cfg.elevenLabs.apiKey }, body: form });
  if (!res.ok) throw new Error(`Speech to text failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return (body.text || '').trim();
}

module.exports = { transcribe };
