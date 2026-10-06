// Questions about what's on screen: "what does this button do?", "what's this
// error mean?", "summarize this", "which one should I pick?".
//
// When a question is vague ("this", "it", "here") the sensible reading is that
// it's about what's in front of them: the front window, the file it has open,
// the selected text, the field they're in. Claude gets exactly that, plus the
// accessibility list of what's visible, and answers briefly, pointing at the
// thing it's talking about when that helps. If it turns out they want
// something done rather than explained, it says so and the request carries on
// down the normal path (a learned skill, or a best effort).

const { Anthropic } = require('@anthropic-ai/sdk');
const { describeScreen } = require('./guide');
const { screenContext } = require('./observe');

const MODEL = 'claude-opus-5-5';

// Questions (as opposed to "how do I…" tasks or "where's X" pointing).
const QUESTION = /^(?:(?:hey|ok(?:ay)?|so|um+)[\s,]+)?(what(?:'s| is| are| does| do| did| am i| should| would| happens)?|whats|why|which|who|is (?:this|that|it|there)|are (?:these|those|there)|does (?:this|that|it)|do (?:i|you|these)|should i|can you (?:explain|tell me|read|summari[sz]e|translate)|explain|summari[sz]e|tell me (?:about|what)|describe|read (?:me |this|that|it)|translate|define|help me understand)\b/i;
const NOT_QUESTION = /^(?:what(?:'s| is) the (?:way|best way) to|how\b|where\b)/i;

function isScreenQuestion(text) {
  const t = String(text || '').trim();
  return QUESTION.test(t) && !NOT_QUESTION.test(t);
}

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['answer', 'task'] },
    say: { type: 'string' },
    target_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    needs_picture: { type: 'boolean' },
  },
  required: ['kind', 'say', 'target_id', 'needs_picture'],
  additionalProperties: false,
};

function system(voice) {
  return `${voice}

Someone asked you something while using their Mac. When it's vague ("this", "it", "that", "here", "these"), assume it's about what's on their screen right now: the front window, the file it has open, the selected text, the field they're typing in, or what's most prominent. Don't ask which; pick the most sensible reading and answer.

You get that context and a numbered list of what's visible (from macOS accessibility, as text; no image), each line "id | role | "label" | app | x,y".

- kind "answer": answer it in one to three short spoken sentences (no markdown, ids or coordinates). If you're talking about something specific on screen (a button, a field, an error message), point at it with target_id. If the screen doesn't hold enough to answer, say what you can see and what you can't, briefly.
- kind "task": they actually want something done or shown step by step ("can you send this", "help me fill this in"), not explained. say "" and target_id null; another part of the assistant will handle it.
- needs_picture: true when answering properly needs seeing it (a diagram, picture, chart, colours, layout, or content the list doesn't describe); the assistant will then look at a screenshot instead. Otherwise false.`;
}

const VOICES = {
  friday: 'You are Friday, a warm, clear helper who lives as a glowing orb on their screen.',
  jarvis: (address) => `You are J.A.R.V.I.S., the calm, capable AI butler from Iron Man: polite, concise, with a dry British wit.${address ? ` You address the user as "${address}" now and then.` : ''}`,
};

async function answerAboutScreen(apiKey, { question, scan, agent = 'friday', address = '', history = '', client = null }) {
  const c = client || new Anthropic({ apiKey });
  const screen = describeScreen((scan && scan.elements) || []);
  const voice = agent === 'jarvis' ? VOICES.jarvis(address) : VOICES.friday;
  const response = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 1500,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    // Over the 512-token minimum, so repeat calls read it from the prompt cache.
    system: [{ type: 'text', text: system(voice), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${history ? `Recent conversation (read the question in light of it):\n${history}\n\n` : ''}They asked: "${question}"\n\nWhat's in front of them: ${screenContext(scan)}\n\nOn screen:\n${screen.text || '(nothing readable)'}` }],
  });
  if (response.stop_reason !== 'end_turn') return { kind: 'task', say: '', target: null, needsPicture: false };
  try {
    const r = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    return { kind: r.kind === 'answer' ? 'answer' : 'task', say: r.say || '', target: Number.isInteger(r.target_id) ? screen.chosen[r.target_id] || null : null, needsPicture: Boolean(r.needs_picture) };
  } catch {
    return { kind: 'task', say: '', target: null, needsPicture: false };
  }
}

module.exports = { answerAboutScreen, isScreenQuestion };
