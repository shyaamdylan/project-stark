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
  };
}

module.exports = { loadConfig, parseEnv };
