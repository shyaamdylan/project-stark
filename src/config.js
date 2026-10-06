// Loads API keys and settings from a .env file (no dependencies).
//
// Search order (later files override earlier ones, real env vars win over all):
//   1. <project root>/.env                              (handy during `npm start`)
//   2. ~/Library/Application Support/Project Alpha/.env (for the packaged app)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_CLOSABLE, PROFILES } = require('./organize');

const list = (v) => String(v || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

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

  // JARVIS_WORKSPACE_<NAME>=App, App adds or replaces a focus profile, so
  // "organise for <name>" keeps exactly those apps.
  const profiles = { ...PROFILES };
  for (const [k, v] of Object.entries({ ...fileVals, ...process.env })) {
    const m = k.match(/^JARVIS_WORKSPACE_([A-Z0-9_]+)$/);
    if (m && v) profiles[m[1].toLowerCase().replace(/_/g, ' ')] = list(v);
  }

  return {
    loadedFrom,
    elevenLabs: {
      apiKey: get('ELEVENLABS_API_KEY'),
      voiceId: get('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8EgDs7'),
      modelId: get('ELEVENLABS_MODEL_ID', 'eleven_flash_v2_5'),
    },
    // Reserved for future features; nothing reads these yet.
    anthropicApiKey: get('ANTHROPIC_API_KEY'),
    openaiApiKey: get('OPENAI_API_KEY'),
    voiceEnabled: get('VOICE_ENABLED', '1') !== '0',
    jarvis: {
      // Only windows of these apps may be closed by "clean up" (always after asking once).
      closableApps: get('JARVIS_CLOSABLE_APPS') ? list(get('JARVIS_CLOSABLE_APPS')) : DEFAULT_CLOSABLE,
      profiles,
      projectDirs: list(get('JARVIS_PROJECT_DIRS')).map(expandHome),
      editor: get('JARVIS_EDITOR'),
    },
  };
}

module.exports = { loadConfig, parseEnv };
