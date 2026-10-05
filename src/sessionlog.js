// A log of each run, to read back or send when something goes wrong.
//
// Everything printed to the terminal is also written, with times, to
//   ~/Library/Application Support/Project Stark/logs/session-<date>.log
// and the conversation itself is printed and written as plain lines:
//   12:04:31  You: where's the export button
//   12:04:33  Friday: There's the Export button! [pointing at "Export"]
// The last 20 sessions are kept.

const fs = require('fs');
const path = require('path');
const util = require('util');

const KEEP = 20;
const NAMES = { friday: 'Friday', jarvis: 'Jarvis' };

const clock = (d = new Date()) => d.toTimeString().slice(0, 8);
const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

let stream = null;
let filePath = null;

// Wrap console so the whole terminal output goes to the file too.
function startSessionLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const old = fs.readdirSync(dir).filter((f) => /^session-.*\.log$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - (KEEP - 1)))) fs.rmSync(path.join(dir, f), { force: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  filePath = path.join(dir, `session-${stamp}.log`);
  stream = fs.createWriteStream(filePath, { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      if (stream) stream.write(`${clock()}  ${level === 'log' ? '' : `${level.toUpperCase()} `}${util.format(...args)}\n`);
    };
  }
  console.log(`[log] this session is being written to ${filePath}`);
  return filePath;
}

const sessionLogPath = () => filePath;

// One line of the conversation, printed (and so written) clearly.
function convo(who, text, extra = '') {
  const t = oneLine(text);
  if (!t && !extra) return;
  console.log(`💬 ${who}: ${[t, extra].filter(Boolean).join(' ')}`);
}

// What the orb is about to say or do, from a message main sends to it.
// `agent` is who you're talking to right now.
function convoFromSend(channel, p, agent) {
  if (!p) return;
  const name = NAMES[agent] || 'Assistant';
  switch (channel) {
    case 'say':
      if (p.text) convo(name, p.text, p.speak === false ? '(shown, not spoken)' : '');
      break;
    case 'guide-step':
      if (p.say || (p.label && !p.quietMove)) convo('Friday', p.say || '', `${p.label ? `[pointing at "${p.label}"]` : ''}${p.chat ? ' (tutor)' : ''}${p.status && p.status !== 'step' ? ` [${p.status}]` : ''}`.trim());
      break;
    case 'jarvis-step':
      if (p.say) convo('Jarvis', p.say);
      else if (p.label) convo('Jarvis', '', `[pointing at "${p.label}"]`);
      break;
    case 'jarvis-state':
      if (p.running) convo('Jarvis', '', `[started: ${p.title || 'task'}]`);
      else convo('Jarvis', p.say || '', `[${p.status}]`);
      break;
    case 'teach-question':
      convo(name, p.text, `[asks${p.phase ? `, ${p.phase}` : ''}]`);
      break;
    case 'teach-status':
      convo(name, p.text, '(status)');
      break;
    case 'question-cancel':
      convo(name, '', '[question withdrawn]');
      break;
    default:
  }
}

// The reply to a request, which the orb says itself.
function convoFromReply(res, agent) {
  if (!res) return;
  const name = NAMES[agent] || 'Assistant';
  if (res.clarify) return convo(name, res.question, '[asks]');
  if (res.guide) return convo(name, '', `[starting lesson${res.title ? `: ${res.title}` : ''}]`);
  if (res.jarvis) return;
  convo(name, res.say || '', `${res.label ? `[pointing at "${res.label}"]` : ''}${res.ok === false ? ` [${res.reason || 'failed'}]` : ''}`.trim());
}

module.exports = { startSessionLog, sessionLogPath, convo, convoFromSend, convoFromReply };
