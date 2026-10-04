// ElevenLabs text-to-speech. Runs in the main process so the API key never
// reaches the renderer. Returns MP3 bytes as base64, or null if voice is off /
// unconfigured (the renderer then falls back to the system voice).

const cache = new Map(); // short phrases repeat a lot ("Hmm, let me look...")
const CACHE_LIMIT = 50;

async function synthesize(text, cfg) {
  if (!cfg.voiceEnabled || !cfg.elevenLabs.apiKey) return null;
  const { apiKey, voiceId, modelId } = cfg.elevenLabs;

  const cacheKey = `${voiceId}|${modelId}|${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3 },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }

  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, b64);
  return b64;
}

module.exports = { synthesize };
