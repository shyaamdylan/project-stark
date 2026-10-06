// Forks in a learned task: a choice that adds steps only one option needs
// (a simpler version, an extra export, a second format). In the Work Map those
// steps carry only_if, naming the option; every other step has only_if null.
//
// A lesson or a run follows one path through the forks, so its step count is
// the steps on that path: an option nobody has taken yet isn't counted, and
// one that's been left out is skipped as a whole.

const { Anthropic } = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

const optionOf = (step) => (step && typeof step.only_if === 'string' && step.only_if.trim() ? step.only_if.trim() : null);

// [{ option, steps: [0-based step indexes] }], in the order they come up.
function forksOf(map) {
  const out = new Map();
  (map.steps || []).forEach((s, i) => {
    const o = optionOf(s);
    if (!o) return;
    if (!out.has(o)) out.set(o, []);
    out.get(o).push(i);
  });
  return [...out].map(([option, steps]) => ({ option, steps }));
}

// The steps that belong to the same option as step i (just [i] if it's not optional).
function branchOf(map, i) {
  const o = optionOf(map.steps[i]);
  if (!o) return [i];
  return forksOf(map).find((f) => f.option === o).steps;
}

// Where step i (0-based) is on the path, for "Step n of m". skipped: step
// indexes left out; chosen: options taken. A step of an option not decided yet
// counts only while it's the one in front of them.
function progress(map, i, { skipped = new Set(), chosen = new Set() } = {}) {
  const current = optionOf(map.steps[i]);
  const counts = (s, j) => !skipped.has(j) && (!optionOf(s) || chosen.has(optionOf(s)) || optionOf(s) === current);
  let n = 0;
  let of = 0;
  (map.steps || []).forEach((s, j) => {
    if (!counts(s, j)) return;
    of++;
    if (j <= i) n++;
  });
  return { n: Math.max(1, n), of: Math.max(1, of) };
}

const DECIDE_SYSTEM = `A learned task has optional parts: steps that only apply if the person wants a particular option. From what the person asked for, decide each option: "take" if their request clearly wants it, "leave" if it clearly doesn't (they asked for something that rules it out), or "ask" if the request doesn't say. Plain requests that just name the task say nothing about options: "ask".`;

const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: { option: { type: 'string' }, decision: { type: 'string', enum: ['take', 'leave', 'ask'] } },
        required: ['option', 'decision'],
        additionalProperties: false,
      },
    },
  },
  required: ['options'],
  additionalProperties: false,
};

// Does what they asked for already settle any fork? Map option -> 'take' |
// 'leave' | 'ask'. No forks, or nothing asked: no call, everything 'ask'.
async function decideForks({ apiKey, client = null, map, request }) {
  const forks = forksOf(map);
  const out = new Map(forks.map((f) => [f.option, 'ask']));
  const asked = String(request || '').trim();
  if (!forks.length || !asked) return out;
  try {
    const c = client || new Anthropic({ apiKey });
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 800,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DECIDE_SCHEMA } },
      system: [{ type: 'text', text: DECIDE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Task: ${map.title}\nOptions:\n${forks.map((f) => `- ${f.option}`).join('\n')}\n\nThey asked: "${asked}"` }],
    });
    const r = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    for (const d of r.options || []) if (out.has(d.option) && ['take', 'leave'].includes(d.decision)) out.set(d.option, d.decision);
  } catch (err) {
    console.error('[forks]', err.message);
  }
  return out;
}

module.exports = { optionOf, forksOf, branchOf, progress, decideForks };
