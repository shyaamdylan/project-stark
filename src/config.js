// Loads API keys and settings from a .env file (no dependencies).
//
// Search order (later files override earlier ones, real env vars win over all):
//   1. <project root>/.env                              (handy during `npm start`)
//   2. ~/Library/Application Support/Project Stark/.env (for the packaged app)

const fs = require('fs');
const path = require('path');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadConfig(userDataDir) {
  const candidates = [path.join(__dirname, '..', '.env')];
  if (userDataDir) candidates.push(path.join(userDataDir, '.env'));

  const fileVals = {};
  const loadedFrom = [];
  for (const file of candidates) {
    try {
      Object.assign(fileVals, parseEnv(fs.readFileSync(file, 'utf8')));
      loadedFrom.push(file);
    } catch {
      // missing file is fine
    }
  }

  const get = (k, def = '') => process.env[k] || fileVals[k] || def;

  return {
    loadedFrom,
    elevenLabs: {
      apiKey: get('ELEVENLABS_API_KEY'),
      voiceId: get('ELEVENLABS_VOICE_ID', 'cgSgspJ2msm6clMCkdW9'),
      modelId: get('ELEVENLABS_MODEL_ID', 'eleven_v4_turbo'),
    },
    // Reserved for future features; nothing reads these yet.
    anthropicApiKey: get('ANTHROPIC_API_KEY'),
    openaiApiKey: get('OPENAI_API_KEY'),
    voiceEnabled: get('VOICE_ENABLED', '1') !== '0',
    // Say this to wake the buddy ("Hey Friday, how do I…"). Needs ELEVENLABS_API_KEY.
    wakeWord: get('WAKE_WORD', 'friday'),
    wakeEnabled: get('WAKE_WORD_ENABLED', '1') !== '0',
    // Take a screenshot of the front window when accessibility isn't enough
    // (diagrams, pictures, apps that describe nothing). Needs Screen Recording.
    visionEnabled: get('VISION_ENABLED', '1') !== '0',
    // "always": every question, pointing request, lesson turn and Jarvis step
    // sees a screenshot. "smart": only when accessibility isn't enough.
    screenMode: /^smart$/i.test(get('SCREEN_MODE', 'always')) ? 'smart' : 'always',
    // What a screenshot covers: "screen" (the whole display the front window is
    // on, so windows behind it and side by side count) or "window" (front only).
    // Where the orb lives: "corner" (bottom right), "auto" (in the notch on a
    // MacBook that has one, else the corner) or "notch" (top centre, everywhere).
    orbPlace: ['notch', 'auto'].find((p) => p === String(get('ORB_PLACE', 'corner')).toLowerCase()) || 'corner',
    screenArea: /^window$/i.test(get('SCREEN_AREA', 'screen')) ? 'window' : 'screen',
    // Jarvis does learned tasks for you. Say "Hey Jarvis" to talk to him.
    jarvis: {
      // ElevenLabs "George": a warm, mature British voice.
      voiceId: get('JARVIS_VOICE_ID', 'JBFqnCBsd6RMkjVDRZzb'),
      wakeWord: get('JARVIS_WAKE_WORD', 'jarvis'),
      // How he addresses you: "sir", "ma'am", your name, or "none".
      address: (() => {
        const a = get('JARVIS_ADDRESS', 'sir').trim();
        return /^(none|off|-)$/i.test(a) ? '' : a;
      })(),
    },
  };
}

module.exports = { loadConfig, parseEnv };
