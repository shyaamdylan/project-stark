// ElevenLabs text-to-speech. Runs in the main process so the API key never
// reaches the renderer.
//
// The renderer plays tts://speak/?text=…&mood=… (see main.js), which streams
// straight from ElevenLabs, so the voice starts within a couple of hundred
// milliseconds instead of after the whole clip is made. Lines that repeat (or
// were prepared ahead, like walkthrough steps) are cached and play instantly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cache = new Map(); // `${voice}|${model}|${mood}|${text}` -> Buffer
const CACHE_LIMIT = 120;

// Short lines that come up again and again (the greeting, "Yes?", fillers,
// acknowledgements) are also kept on disk, so they're paid for once per voice
// rather than on every launch. Long one-off answers stay in memory only.
const DISK_MAX_CHARS = 90;
const DISK_LIMIT = 400;
let diskDir = null;
function setDiskCache(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    diskDir = dir;
  } catch {
    diskDir = null;
  }
}
const diskFile = (key) => path.join(diskDir, `${crypto.createHash('sha1').update(key).digest('hex')}.mp3`);
const reusable = (key) => key.split('|').slice(3).join('|').length <= DISK_MAX_CHARS;

function fromDisk(key) {
  if (!diskDir || !reusable(key)) return null;
  try {
    const buf = fs.readFileSync(diskFile(key));
    cache.set(key, buf);
    return buf;
  } catch {
    return null;
  }
}

function toDisk(key, buf) {
  if (!diskDir || !reusable(key) || !buf.length) return;
  try {
    fs.writeFileSync(diskFile(key), buf);
    const files = fs.readdirSync(diskDir).filter((f) => f.endsWith('.mp3'));
    if (files.length > DISK_LIMIT) {
      // Drop the ones least recently made.
      files
        .map((f) => ({ f, t: fs.statSync(path.join(diskDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .slice(0, files.length - DISK_LIMIT)
        .forEach(({ f }) => fs.unlinkSync(path.join(diskDir, f)));
    }
  } catch {}
}

const cached = (key) => cache.get(key) || fromDisk(key);

const fallbackVoices = new Map(); // configured voice id -> one that is on this account

// Expressive models take delivery cues in brackets; they're performed, not read out.
// Only a warm cue for friendly lines. Apologies and "can't do that" get none:
// cues like [gently] make v4 drop to a near-whisper, and the voice's normal
// tone is already kind.
const EXPRESSIVE = /^eleven_(v3|v4)/;
const MOOD_TAGS = { happy: '[warmly]' };

// Each agent has its own voice. Jarvis is calmer and steadier, and gets no
// delivery cues: his dry, even tone is the point.
function voiceFor(cfg, agent) {
  if (agent === 'jarvis') {
    return { voiceId: cfg.jarvis.voiceId, tags: {}, settings: { stability: 0.6, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true } };
  }
  return { voiceId: cfg.elevenLabs.voiceId, tags: MOOD_TAGS, settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } };
}

function prepare(text, mood, modelId, tags) {
  const tag = EXPRESSIVE.test(modelId) && tags[mood];
  return tag ? `${tag} ${text}` : text;
}

// The first ready-made voice on the account, for when the configured one is missing.
async function findFallbackVoice(apiKey) {
  const res = await fetch('https://api.elevenlabs.io/v2/voices?page_size=50', { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) return null;
  const { voices = [] } = await res.json();
  const pick = voices.find((v) => v.category === 'premade') || voices[0];
  return pick ? pick.voice_id : null;
}

function cacheKey(text, cfg, mood, agent) {
  const { voiceId } = voiceFor(cfg, agent);
  return `${fallbackVoices.get(voiceId) || voiceId}|${cfg.elevenLabs.modelId}|${mood || ''}|${text}`;
}

function remember(key, buf) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, buf);
  toDisk(key, buf);
}

// Start an ElevenLabs stream. Retries once with a fallback voice if needed.
async function request(text, cfg, mood, agent) {
  const { apiKey, modelId } = cfg.elevenLabs;
  const v = voiceFor(cfg, agent);
  const voiceId = fallbackVoices.get(v.voiceId) || v.voiceId;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: prepare(text, mood, modelId, v.tags),
      model_id: modelId,
      // Lower stability = more expressive and natural; speaker boost keeps it close to the voice.
      voice_settings: v.settings,
    }),
  });
  if (res.ok) return res;
  const detail = await res.text().catch(() => '');
  if (res.status === 404 && detail.includes('voice_not_found') && !fallbackVoices.has(v.voiceId)) {
    const fallback = await findFallbackVoice(apiKey);
    if (fallback) {
      fallbackVoices.set(v.voiceId, fallback);
      const key = agent === 'jarvis' ? 'JARVIS_VOICE_ID' : 'ELEVENLABS_VOICE_ID';
      console.warn(`[voice] Voice ${voiceId} isn't on this ElevenLabs account; using ${fallback}. Set ${key} in .env to choose.`);
      return request(text, cfg, mood, agent);
    }
  }
  throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
}

const AUDIO_HEADERS = { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

// A streaming Response for the tts:// protocol. Cached lines come back at once;
// new ones are played as they arrive and saved for next time.
async function stream(text, cfg, mood, agent = 'friday') {
  const key = cacheKey(text, cfg, mood, agent);
  const hit = cached(key);
  if (hit) return new Response(hit, { headers: AUDIO_HEADERS });
  const res = await request(text, cfg, mood, agent);
  const [play, keep] = res.body.tee();
  new Response(keep)
    .arrayBuffer()
    .then((ab) => remember(key, Buffer.from(ab)))
    .catch(() => {});
  return new Response(play, { headers: AUDIO_HEADERS });
}

// Whole clip, for preparing lines ahead of time. Returns null if voice is off.
async function synthesize(text, cfg, mood = 'happy', agent = 'friday') {
  if (!cfg.voiceEnabled || !cfg.elevenLabs.apiKey) return null;
  const key = cacheKey(text, cfg, mood, agent);
  const hit = cached(key);
  if (hit) return hit;
  const res = await request(text, cfg, mood, agent);
  const buf = Buffer.from(await res.arrayBuffer());
  remember(key, buf);
  return buf;
}

module.exports = { synthesize, stream, setDiskCache };
