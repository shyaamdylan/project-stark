// The apprentice's thinking: what to ask while the expert works, and how to turn
// a session (screen events + answers) into a Work Map someone else can follow.
//
// Screen events come from the accessibility scan, so they're exact text
// ("Cost center: 4711 → 0400"), not guesses from screenshots.

const { Anthropic } = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

// ---------- formatting what happened for Claude ----------

function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const ROLE_WORDS = {
  AXButton: 'button', AXMenuButton: 'menu button', AXPopUpButton: 'dropdown', AXLink: 'link', AXTab: 'tab',
  AXRadioButton: 'option', AXCheckBox: 'checkbox', AXMenuBarItem: 'menu', AXMenuItem: 'menu item',
  AXSearchField: 'search field', AXTextField: 'field', AXTextArea: 'text area', AXComboBox: 'field',
  AXSlider: 'slider', AXCell: 'cell', AXRow: 'row', AXDockItem: 'Dock icon',
};

function showValue(role, v) {
  if (role === 'AXCheckBox' || role === 'AXRadioButton') return v === '1' ? 'on' : 'off';
  return v === '' ? '(empty)' : `"${v}"`;
}

function describeEvent(e) {
  const t = clock(e.t);
  const what = ROLE_WORDS[e.role] || 'item';
  switch (e.type) {
    case 'edit':
      return `e${e.id} ${t} changed ${what} "${e.label}": ${showValue(e.role, e.from)} → ${showValue(e.role, e.to)}`;
    case 'click':
      return `e${e.id} ${t} clicked ${what} "${e.label}"`;
    case 'shortcut':
      return `e${e.id} ${t} pressed ${e.keys}`;
    case 'say':
      return `e${e.id} ${t} expert said: "${e.text}"`;
    case 'screen':
      return `e${e.id} ${t} now in ${e.app}${e.window ? ` — "${e.window}"` : ''}${e.fields ? ` (showing ${e.fields})` : ''}`;
    default:
      return `e${e.id} ${t} ${e.type}`;
  }
}

function describeQas(qas) {
  if (!qas.length) return '(none yet)';
  return qas.map((q) => `q${q.id} ${clock(q.t)} [${q.phase}] Q: ${q.question}\n   A: ${q.answer || '(skipped)'}`).join('\n');
}

// What's on screen right now, compactly: labels and values the expert can see.
function describeScreen(elements, limit = 120) {
  const keep = elements
    .filter((e) => e.role !== 'AXMenuBarItem')
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .slice(0, limit);
  return keep.map((e) => ('value' in e ? `${ROLE_WORDS[e.role] || 'field'} "${e.label}" = ${showValue(e.role, e.value)}` : `${ROLE_WORDS[e.role] || 'text'} "${e.label}"`)).join('\n');
}

// ---------- prompts and schemas ----------

const QUESTION_SYSTEM = `You are an apprentice learning how an expert does their job by watching their screen. The expert has just paused. Decide whether one question is worth asking right now.

Ask about judgment, not mechanics: a value they changed, something they held, skipped, escalated or sent to someone else, or a case they handled differently from another. Skip anything the screen already explains and anything you've already asked.

Kinds of question:
- "why": the reason for a decision.
- "guardrail": a limit, an exception, or when they would stop and ask someone.
- "what_if": what would make them decide differently.
Make sure at least one question in the session is a guardrail question.

The question is spoken aloud at a natural pause, so keep it short (under 25 words), friendly, and about something concrete on screen: name the field, value or item. No preamble.

The expert may also explain things out loud while working ("expert said" events). Never ask about something they've already explained; build on it instead.

If nothing is worth asking yet, set ask to false.`;

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    ask: { type: 'boolean' },
    kind: { type: 'string', enum: ['why', 'guardrail', 'what_if'] },
    question: { type: 'string' },
    event_ids: { type: 'array', items: { type: 'integer' } },
  },
  required: ['ask', 'kind', 'question', 'event_ids'],
  additionalProperties: false,
};

const MAP_SYSTEM = `You are an apprentice who has just watched an expert do a task on their screen, asking questions along the way. Turn the session into a Work Map: the steps a new person would follow, with the expert's reasoning and guardrails, so they could do the task on a case the expert never showed.

You get the screen events (e-numbers, with times), including what the expert said out loud while working ("expert said"), and the questions and answers (q-numbers).

Rules:
- Group events into meaningful steps (usually 4 to 10). A step is something a person decides or does, not every keystroke.
- Mark is_judgment true where the expert made a call that depends on the situation.
- reason must use the expert's own words (quote them), from an answer (name it in reason_qa_id) or from something they said while working (name that event in reason_event_id). Never invent a reason; use null if you don't know.
- rule is the decision as a general, checkable condition (e.g. "Equipment over €5,000 is coded to capex 0400"), or null.
- guardrails are limits, exceptions, and moments to stop and ask someone. Only include ones the expert stated or clearly showed, linked to the answer (qa_id) when there is one.
- open_questions: the most important things still unclear (exceptions you noticed, rules you're unsure of, cases you haven't seen), at most 3, each a short spoken question.
- teach_back: explain the whole process back in your own words, as you'd say it aloud, in under 120 words, starting with "Here's how I understand it". Mention the judgment calls and guardrails.`;

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    action: { type: 'string' },
    event_ids: { type: 'array', items: { type: 'integer' } },
    is_judgment: { type: 'boolean' },
    decision: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    reason_qa_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    reason_event_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    rule: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    guardrails: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['limit', 'exception', 'stop_and_ask'] },
          text: { type: 'string' },
          qa_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
        required: ['kind', 'text', 'qa_id'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'action', 'event_ids', 'is_judgment', 'decision', 'reason', 'reason_qa_id', 'reason_event_id', 'rule', 'guardrails'],
  additionalProperties: false,
};

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    steps: { type: 'array', items: STEP_SCHEMA },
    open_questions: { type: 'array', items: { type: 'string' } },
    teach_back: { type: 'string' },
  },
  required: ['title', 'summary', 'steps', 'open_questions', 'teach_back'],
  additionalProperties: false,
};

// ---------- calling Claude ----------

class Apprentice {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  async json(system, user, schema, { effort = 'low', maxTokens = 4000 } = {}) {
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort, format: { type: 'json_schema', schema } },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      });
    } catch (err) {
      console.error('[apprentice]', err.status || '', err.message);
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room to answer.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  }

  // One question at a pause, or { ask: false }.
  pickQuestion({ title, events, recentFrom, qas, screen, asked }) {
    const recent = events.filter((e) => e.id >= recentFrom);
    const user = [
      `Task the expert is showing: ${title}`,
      `Questions asked so far: ${asked} (guardrail questions: ${qas.filter((q) => q.kind === 'guardrail').length})`,
      `Earlier events:\n${events.filter((e) => e.id < recentFrom).slice(-25).map(describeEvent).join('\n') || '(none)'}`,
      `What just happened (ask about this):\n${recent.map(describeEvent).join('\n')}`,
      `Questions and answers so far:\n${describeQas(qas)}`,
      `On screen now:\n${screen}`,
    ].join('\n\n');
    return this.json(QUESTION_SYSTEM, user, QUESTION_SCHEMA, { effort: 'low', maxTokens: 2000 });
  }

  draftMap({ title, events, qas }) {
    const user = [
      `Task: ${title}`,
      `Screen events:\n${events.map(describeEvent).join('\n') || '(none)'}`,
      `Questions and answers:\n${describeQas(qas)}`,
    ].join('\n\n');
    return this.json(MAP_SYSTEM, user, MAP_SCHEMA, { effort: 'medium', maxTokens: 12000 });
  }

  finalizeMap({ title, events, qas, draft, teachBackReply }) {
    const user = [
      `Task: ${title}`,
      `Screen events:\n${events.map(describeEvent).join('\n') || '(none)'}`,
      `Questions and answers (including the debrief):\n${describeQas(qas)}`,
      `Your draft Work Map:\n${JSON.stringify(draft)}`,
      `You explained it back: "${draft.teach_back}"`,
      `The expert replied: "${teachBackReply || '(confirmed, no changes)'}"`,
      'Produce the final Work Map. Apply every correction and every debrief answer. open_questions should list only what is still unclear after the debrief (often none). Rewrite teach_back to reflect the corrected process.',
    ].join('\n\n');
    return this.json(MAP_SYSTEM, user, MAP_SCHEMA, { effort: 'medium', maxTokens: 12000 });
  }
}

module.exports = { Apprentice, describeEvent, describeScreen, clock };
