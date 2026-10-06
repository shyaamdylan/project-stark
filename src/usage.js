// What every Claude call costs: tokens in (and how many came from the prompt
// cache), tokens out, and an estimate in dollars, per kind of call and for the
// whole session. Logged to the terminal and the session log, so we can see
// where the tokens go and whether caching is working.
//
// It hooks the SDK's beta messages.create once (install()), so no call site has
// to remember to report; the label is the function that made the call.

const path = require('path');

// $ per million tokens: [input, output, cache read, cache write (5 min)].
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
};

const totals = new Map(); // label -> { calls, input, cacheRead, cacheWrite, output, cost }
const session = { calls: 0, cost: 0 };

function costOf(model, u) {
  const p = PRICES[String(model || '').replace(/-\d{8}$/, '')] || PRICES['claude-opus-5-5'];
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
}

// The call site, from the stack: "Tutor.turn" or "lookAtScreen".
function labelFrom(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    if (/usage\.js|node_modules|node:internal/.test(line)) continue;
    const m = /at (?:async )?([\w.$<>]+) \((.+?):\d+:\d+\)/.exec(line);
    if (m) return m[1] === 'Object.<anonymous>' ? path.basename(m[2]) : m[1];
    const f = /at (.+?):\d+:\d+/.exec(line);
    if (f) return path.basename(f[1]);
  }
  return 'claude';
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

function record(label, response, log = console.log) {
  const u = (response && response.usage) || {};
  const cost = costOf(response && response.model, u);
  const t = totals.get(label) || { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
  t.calls++;
  t.input += u.input_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  t.cacheWrite += u.cache_creation_input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cost += cost;
  totals.set(label, t);
  session.calls++;
  session.cost += cost;
  const inAll = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  log(`[tokens] ${label}: ${fmt(inAll)} in (${fmt(u.cache_read_input_tokens || 0)} from cache), ${fmt(u.output_tokens || 0)} out · ≈$${cost.toFixed(4)} · session ≈$${session.cost.toFixed(3)} over ${session.calls} calls`);
  return cost;
}

// A table of where the session's tokens went, most expensive first.
function summary() {
  const rows = [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost);
  if (!rows.length) return '';
  const lines = rows.map(([label, t]) => {
    const inAll = t.input + t.cacheRead + t.cacheWrite;
    const hit = inAll ? Math.round((t.cacheRead / inAll) * 100) : 0;
    return `  ${label.padEnd(28)} ${String(t.calls).padStart(4)} calls  ${fmt(inAll / t.calls).padStart(7)} in/call (${hit}% cached)  ${fmt(t.output / t.calls).padStart(5)} out/call  ≈$${t.cost.toFixed(3)}`;
  });
  return `[tokens] this session ≈$${session.cost.toFixed(3)} over ${session.calls} Claude calls:\n${lines.join('\n')}`;
}

let installed = false;
function install(log = console.log) {
  if (installed) return;
  installed = true;
  const { Messages } = require('@anthropic-ai/sdk/resources/beta/messages/messages');
  const create = Messages.prototype.create;
  Messages.prototype.create = function (...args) {
    const label = labelFrom(new Error().stack);
    const p = create.apply(this, args);
    // Report when it arrives, without changing what the caller gets back.
    Promise.resolve(p)
      .then((r) => r && r.usage && record(label, r, log))
      .catch(() => {});
    return p;
  };
}

module.exports = { install, record, summary, costOf, labelFrom, totals, session };
