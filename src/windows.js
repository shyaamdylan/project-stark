// Finding an open window or browser tab and bringing it to the front, for
// "Jarvis, switch to the budget spreadsheet" when lots of things are open.
//
// Lists every window of every app (minimised ones too) plus Safari / Chrome /
// Brave / Edge / Arc tabs, then picks the one whose app, title or address best
// matches what was asked. Nothing is opened or closed: it only switches.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalize } = require('./matcher');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'jxa', 'windows.js'), 'utf8');

function runJxa(opts, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(opts)], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        if (/-1719|-25211|assistive access/i.test(msg)) return reject(Object.assign(new Error(msg), { code: 'ACCESSIBILITY' }));
        return reject(new Error(msg));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Could not parse window list: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// Everything open: [{ kind: 'window' | 'tab', app, title, url?, ...where }].
async function listOpen() {
  const r = await runJxa({ op: 'list', excludePid: process.pid, tabs: true });
  if (r.ok === false) throw Object.assign(new Error(r.error), { code: /assistive/.test(r.error) ? 'ACCESSIBILITY' : undefined });
  const windows = (r.windows || []).map((w) => ({ kind: 'window', ...w }));
  const tabs = (r.tabs || []).map((t) => ({ kind: 'tab', ...t }));
  return { windows, tabs };
}

const FILLER = new Set(['the', 'my', 'a', 'an', 'window', 'windows', 'tab', 'tabs', 'app', 'one', 'that', 'this', 'with', 'where', 'i', 'was', 'open', 'please', 'me', 'for', 'to', 'back', 'up', 'on', 'in']);
const words = (t) => normalize(t).split(' ').filter((w) => w && !FILLER.has(w));

// How well an open window or tab matches the request (0 to 1).
function matchScore(want, item) {
  const ws = words(want);
  if (!ws.length) return 0;
  const app = normalize(item.app || '');
  const title = normalize(item.title || '');
  let host = '';
  try {
    host = item.url ? new URL(item.url).hostname.replace(/^www\./, '') : '';
  } catch {}
  const hay = `${app} ${title} ${host}`;
  const hit = ws.filter((w) => hay.includes(w)).length / ws.length;
  if (!hit) return 0;
  const phrase = ws.join(' ');
  let s = 0.5 * hit;
  if (title === phrase || app === phrase) s += 0.45;
  else if (title.includes(phrase) || host.startsWith(phrase)) s += 0.35;
  else if (app.includes(phrase)) s += 0.3;
  // A window's own title beats a background tab with the same words.
  if (item.kind === 'window') s += 0.03;
  return Math.min(1, s);
}

// Best matches first: [{ item, score }].
function rankOpen(want, { windows, tabs }) {
  return [...windows, ...tabs]
    .map((item) => ({ item, score: matchScore(want, item) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

// What to call it out loud: "Budget.xlsx in Numbers", "the YouTube tab in Safari".
function describe(item) {
  const title = (item.title || '').replace(/\s+/g, ' ').trim();
  if (item.kind === 'tab') return `the ${title.length > 40 ? `${title.slice(0, 40)}…` : title || 'tab'} tab in ${item.app}`;
  return title && normalize(title) !== normalize(item.app) ? `${title.length > 40 ? `${title.slice(0, 40)}…` : title} in ${item.app}` : item.app;
}

async function bringToFront(item) {
  const r = item.kind === 'tab'
    ? await runJxa({ op: 'tab', app: item.app, window: item.window, tab: item.tab })
    : await runJxa({ op: 'raise', pid: item.pid, index: item.index, title: item.title });
  if (!r.ok) throw new Error(r.error || 'could not switch');
  return true;
}

// For descriptions rather than names ("the window I had the meeting in"):
// Claude reads the list of what's open and picks. Returns { match: 'one' |
// 'several' | 'none', items: [...] } (several: up to 3 to ask between).
const PICK_SCHEMA = {
  type: 'object',
  properties: {
    match: { type: 'string', enum: ['one', 'several', 'none'] },
    ids: { type: 'array', items: { type: 'integer' } },
  },
  required: ['match', 'ids'],
  additionalProperties: false,
};

function describeForPick(items) {
  return items
    .map((x, i) => {
      let host = '';
      try {
        host = x.url ? new URL(x.url).hostname : '';
      } catch {}
      return `${i} | ${x.kind}${x.minimized ? ' (minimised)' : ''} | ${x.app} | "${String(x.title || '').replace(/"/g, "'").slice(0, 120)}"${host ? ` | ${host}` : ''}`;
    })
    .join('\n');
}

async function pickWithClaude(apiKey, request, { windows: ws, tabs }, client = null) {
  const items = [...ws, ...tabs].slice(0, 250);
  if (!items.length) return { match: 'none', items: [] };
  const { Anthropic } = require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ apiKey });
  const response = await c.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 800,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PICK_SCHEMA } },
    system: `Pick which open window or browser tab on someone's Mac they mean. They may describe it by what was in it rather than its name: "the window I had the meeting in" is a Zoom, Teams, Webex, FaceTime or Slack huddle window, or a Google Meet / Teams / Zoom tab; "the doc I was writing" is a document window or a Google Docs tab; "the email from Sam" is a Mail or Gmail window whose title mentions Sam.
- "one": you're confident which; ids holds it.
- "several": it could be any of 2 or 3; ids holds them, most likely first.
- "none": nothing open fits; ids empty.
Only use ids from the list.`,
    messages: [{ role: 'user', content: `They asked for: "${request}"\n\nOpen (id | kind | app | "title" | site):\n${describeForPick(items)}` }],
  });
  if (response.stop_reason !== 'end_turn') return { match: 'none', items: [] };
  const r = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const picked = [...new Set(r.ids || [])].map((i) => items[i]).filter(Boolean).slice(0, 3);
  if (!picked.length || r.match === 'none') return { match: 'none', items: [] };
  return { match: r.match === 'one' || picked.length === 1 ? 'one' : 'several', items: picked };
}

async function inventory() {const r=await runJxa({op:'list',excludePid:process.pid,tabs:false});if(r.ok===false)throw new Error(r.error);return r.windows||[];}
async function changeWindow(action) {const r=await runJxa({op:'manage',...action});if(!r.ok)throw new Error(r.error);return r;}
module.exports = { inventory, changeWindow, listOpen, rankOpen, matchScore, describe, bringToFront, pickWithClaude };
