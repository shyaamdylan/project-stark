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

// ---------- tidying up: from "what this expert did" to "what anyone should do" ----------

// Bump when the cleanup rules change, so older skills are tidied again.
const REFINE_VERSION = 1;

const REFINE_SYSTEM = `You're tidying up a Work Map that was just written from an expert's screen recording, so anyone can follow it from wherever they happen to be.

1. Remove what was incidental to this one recording: where the expert happened to start (an unrelated app, website or page that was already open; for example they were on Facebook, clicked the address bar and typed the address of the site the task is really about), unrelated tabs and windows, notifications, detours, accidental clicks, things they undid, and waiting. Never remove anything the task needs.
2. Describe getting somewhere by where to get to, never by the route from the incidental place. A step whose job is reaching a website, app, page or screen gets kind "go" and a destination: name (how a person would say it), url (the address the expert ended up at, for a website; else null), app (for a desktop app; else null). Its action reads like "Open canva.com in your browser; any tab is fine." Someone who is already there just carries on. Never imply they must start where the expert started. Every other step has kind "do" and destination null.
3. Fill gaps. Things the task relied on that the recording only implies (being signed in, a file or record already open, a setting already on) go in prerequisites, each a short phrase ("Signed in to Canva"). If a step is clearly missing between two recorded ones (a menu had to be opened, a page had to load), add it with inferred true, an action saying what to do, and empty event_ids. Steps from the recording have inferred false.
4. Keep everything that belongs to the task exactly as it is: the expert's reasons and quotes, rules, guardrails, reason_qa_id, reason_event_id, judgment flags. Keep event_ids for what you keep; drop ids that only belonged to removed, incidental actions.
5. Never invent reasons, rules or guardrails. They only ever come from the expert.
6. summary: rewrite only if it mentions incidental things. open_questions: keep as they are. teach_back: update it only if the steps changed, in the same voice, starting "Here's how I understand it".
7. cleanup_notes: what you changed, in plain words for the expert, at most 5 (e.g. "Dropped starting on Facebook: you can open Canva from anywhere."). Empty if nothing needed changing.`;

const REFINED_STEP_SCHEMA = {
  ...STEP_SCHEMA,
  properties: {
    ...STEP_SCHEMA.properties,
    kind: { type: 'string', enum: ['do', 'go'] },
    destination: {
      anyOf: [
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            app: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['name', 'url', 'app'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    inferred: { type: 'boolean' },
  },
  required: [...STEP_SCHEMA.required, 'kind', 'destination', 'inferred'],
};

const REFINE_SCHEMA = {
  type: 'object',
  properties: {
    ...MAP_SCHEMA.properties,
    steps: { type: 'array', items: REFINED_STEP_SCHEMA },
    prerequisites: { type: 'array', items: { type: 'string' } },
    cleanup_notes: { type: 'array', items: { type: 'string' } },
  },
  required: [...MAP_SCHEMA.required, 'prerequisites', 'cleanup_notes'],
  additionalProperties: false,
};

// Only web addresses are kept as destinations (Jarvis may open them).
function cleanUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// Make Claude's tidied map safe to use, falling back to the original where it's off.
function normalizeRefined(original, refined, events) {
  if (!refined || !Array.isArray(refined.steps) || !refined.steps.length) return { ...original, refined: REFINE_VERSION, prerequisites: [], cleanup_notes: [] };
  const ids = new Set((events || []).map((e) => e.id));
  const steps = refined.steps.map((s) => {
    const dest = s.kind === 'go' && s.destination ? { name: String(s.destination.name || '').trim(), url: cleanUrl(s.destination.url), app: s.destination.app ? String(s.destination.app).trim() : null } : null;
    return {
      ...s,
      kind: dest && dest.name ? 'go' : 'do',
      destination: dest && dest.name ? dest : null,
      inferred: Boolean(s.inferred),
      event_ids: (s.event_ids || []).filter((id) => ids.has(id)),
      guardrails: Array.isArray(s.guardrails) ? s.guardrails : [],
    };
  });
  return {
    ...original,
    title: refined.title || original.title,
    summary: refined.summary || original.summary,
    steps,
    open_questions: refined.open_questions || original.open_questions || [],
    teach_back: refined.teach_back || original.teach_back,
    prerequisites: (refined.prerequisites || []).filter(Boolean).slice(0, 8),
    cleanup_notes: (refined.cleanup_notes || []).filter(Boolean).slice(0, 5),
    refined: REFINE_VERSION,
  };
}

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

  // The final pass: drop what was incidental to this recording (where the
  // expert happened to start, detours), turn "how they got there" into "where
  // to get to", and fill the gaps the recording only implies.
  async refineMap({ title, events, qas, map }) {
    const { confirmed, refined, prerequisites, cleanup_notes, ...current } = map;
    const user = [
      `Task: ${title}`,
      `Screen events:\n${events.map(describeEvent).join('\n') || '(none)'}`,
      `Questions and answers:\n${describeQas(qas)}`,
      `Work Map to tidy up:\n${JSON.stringify(current)}`,
    ].join('\n\n');
    const out = await this.json(REFINE_SYSTEM, user, REFINE_SCHEMA, { effort: 'medium', maxTokens: 14000 });
    return { ...normalizeRefined(map, out, events), confirmed: map.confirmed };
  }
}

module.exports = { Apprentice, describeEvent, describeScreen, clock, normalizeRefined, cleanUrl, REFINE_VERSION };
