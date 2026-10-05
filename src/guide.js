// Walks the user through a skill it has learned, one click at a time.
//
// Guidance is grounded in a Work Map recorded from an expert (see teach.js):
// Claude may only lead the user through those steps, with the expert's reasons
// and guardrails. It never makes up a procedure. Each turn we send the Work Map
// once (first turn), then a numbered list of what's on screen now (from the
// accessibility scan), and Claude answers with the single next step: what to
// say and which element to point at for it.

const { Anthropic } = require('@anthropic-ai/sdk');
const { describeEvent } = require('./apprentice');

const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 25;
const MAX_ELEMENTS = 350;

const SYSTEM = `You are the voice of a small on-screen helper on a Mac. You learned a task by watching an expert do it, and now you guide someone else through it, one step at a time, by pointing at things on their screen.

You may only guide through the learned Work Map you are given. Never invent steps, buttons, menus, shortcuts, reasons or rules that are not in it. If the user needs something the Work Map doesn't cover, say so plainly instead of guessing.

Each turn you get a numbered list of the elements visible on screen right now, taken from macOS accessibility. Every line looks like:
  id | role | "label" | app | x,y
The list is front window first. Items under an open menu appear only while that menu is open. Dock icons have role "dock item"; if the Dock auto-hides they're marked "(hidden)".

Reply with the single next step:
- status "step": the Work Map step the user should do now (step_number, counting from 1). Point at the element for it with target_id: match it to what the expert used (the same label, field or item) in the current list. Say what to do in one short, friendly sentence (under 25 words), spoken aloud, so no markdown, ids or coordinates. At a judgment step, briefly give the expert's reason; mention a guardrail when it applies here.
- If the element for the current step isn't on screen, tell them which screen to get to, using the app and window names from the recording, with target_id null.
- status "done": every Work Map step is complete. say a short wrap-up.
- status "stuck": the user is somewhere the Work Map doesn't cover, or wants something it doesn't include. Say so in under 12 words, naming the step to go back to. Don't explain further.

Look at what changed since the last step. If the user didn't do what you asked, repeat it gently. Only use target_id values from the current list; use null when there's nothing to point at.

Where the user starts doesn't matter. A "Get to" step is done as soon as they're at that place, however they got there: if they're already there, move straight on. Never send them to where the expert happened to start.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['step', 'done', 'stuck'] },
    step_number: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    say: { type: 'string' },
    target_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  },
  required: ['status', 'step_number', 'say', 'target_id'],
  additionalProperties: false,
};

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    match: { type: 'string', enum: ['yes', 'maybe', 'no'] },
    skill_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    question: { type: 'string' },
  },
  required: ['match', 'skill_id', 'question'],
  additionalProperties: false,
};

const ROLE_WORDS = {
  AXButton: 'button', AXMenuButton: 'menu button', AXPopUpButton: 'pop-up', AXLink: 'link', AXTab: 'tab',
  AXRadioButton: 'option', AXCheckBox: 'checkbox', AXMenuBarItem: 'menu', AXMenuItem: 'menu item',
  AXSearchField: 'search field', AXTextField: 'text field', AXComboBox: 'combo box', AXSlider: 'slider',
  AXStaticText: 'text', AXImage: 'image', AXCell: 'cell', AXRow: 'row', AXDisclosureTriangle: 'disclosure',
  AXIncrementor: 'stepper', AXColorWell: 'color well', AXDockItem: 'dock item', AXTextArea: 'text area',
};

// Number the elements and render them as compact lines. Long scans are cut to
// the front-most windows; menus and menu bar items are always kept.
function describeScreen(elements) {
  const keepFirst = (e) => e.role === 'AXMenuBarItem' || e.role === 'AXMenuItem' || e.role === 'AXDockItem';
  const rest = elements
    .filter((e) => !keepFirst(e))
    // Paragraph-length text is rarely a step target and costs a lot of tokens.
    .filter((e) => !(e.role === 'AXStaticText' && e.label.length > 80))
    .sort((a, b) => (a.z || 0) - (b.z || 0) || a.y - b.y || a.x - b.x);
  const chosen = elements.filter(keepFirst).concat(rest).slice(0, MAX_ELEMENTS);
  const lines = chosen.map((e, i) =>
    `${i} | ${ROLE_WORDS[e.role] || e.role.replace(/^AX/, '').toLowerCase()} | "${e.label.replace(/"/g, "'")}" | ${e.app || ''} | ${Math.round(e.x)},${Math.round(e.y)}${e.hidden ? ' (hidden)' : ''}`
  );
  return { chosen, text: lines.join('\n') };
}

// The Work Map as text for Claude: each step with what the expert actually did
// on screen, so the guide can find the same things on the user's screen.
// "Get to canva.com (https://www.canva.com/)" for a step that's about reaching a place.
function destinationText(d) {
  if (!d) return '';
  return `${d.name}${d.url ? ` (${d.url})` : d.app ? ` (the ${d.app} app)` : ''}`;
}

// What the task relies on before step 1 ("Signed in to Canva").
function prerequisitesText(map) {
  return map.prerequisites && map.prerequisites.length ? `Before starting: ${map.prerequisites.join('; ')}.` : '';
}

function describeSkill({ map, session }) {
  const events = new Map((session.events || []).map((e) => [e.id, e]));
  const steps = map.steps.map((s, i) => {
    const lines = [`Step ${i + 1}: ${s.title}`, `  Do: ${s.action}`];
    if (s.kind === 'go') lines.push(`  Get to: ${destinationText(s.destination)} (from anywhere; skip if already there)`);
    if (s.decision) lines.push(`  Decision: ${s.decision}`);
    if (s.reason) lines.push(`  Expert's reason: "${s.reason}"`);
    if (s.rule) lines.push(`  Rule: ${s.rule}`);
    for (const g of s.guardrails) lines.push(`  Guardrail (${g.kind.replace(/_/g, ' ')}): ${g.text}`);
    const did = s.event_ids.map((id) => events.get(id)).filter(Boolean).map((e) => `    ${describeEvent(e).replace(/^e\d+ \d\d:\d\d /, '')}`);
    if (did.length) lines.push(s.kind === 'go' ? '  How the expert happened to get there (just one route):' : '  What the expert did on screen:', ...did);
    return lines.join('\n');
  });
  return [`Learned task: ${map.title}`, map.summary, prerequisitesText(map)].filter(Boolean).join('\n') + `\n\n${steps.join('\n\n')}`;
}

const PLAN_SYSTEM = `You turn a recorded demonstration into a clean replay plan: the minimal sequence of actions a learner should do to complete the task, in order.

You get the Work Map (steps, reasons, guardrails) and, under each step, what the expert actually did on screen, each line starting with its event id (e12 …).

Rules:
- Keep only actions the task needs. Drop exploration (trying options and switching back), repeats, undo, accidental clicks, tab switches that aren't needed, and changes the app made by itself (an address bar changing as a page loads).
- If the expert picked something specific to that one case (a particular video, invoice row, file or search result), use kind "choose" with event_id null, and say what to pick in general terms.
- Use kind "click", "edit" or "shortcut" with the expert's event_id for actions on fixed controls (buttons, menus, fields, tabs).
- Use kind "look" with event_id null for a step with nothing to click (wait for something, check a result).
- A step marked "Get to" is about reaching a place, not the route there: give it exactly one action, kind "go" with event_id null, saying where to get to ("Open canva.com in your browser."). Never replay how the expert happened to get there (clicking an address bar on some other site, switching from an unrelated app).
- Every action has a short spoken line (under 20 words) saying what to do, using only the Work Map. Say key names as words ("Command C"). On the first action of a judgment step, add the expert's reason briefly.
- Never add actions, buttons or advice that aren't in the recording or the Work Map.`;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step_number: { type: 'integer' },
          event_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          kind: { type: 'string', enum: ['click', 'edit', 'shortcut', 'choose', 'look', 'go'] },
          say: { type: 'string' },
        },
        required: ['step_number', 'event_id', 'kind', 'say'],
        additionalProperties: false,
      },
    },
  },
  required: ['actions'],
  additionalProperties: false,
};

// One-off per skill: clean the recording into the actions a learner repeats.
async function planReplay(apiKey, skill) {
  const client = new Anthropic({ apiKey });
  const events = new Map((skill.session.events || []).map((e) => [e.id, e]));
  const steps = skill.map.steps.map((s, i) => {
    const did = s.event_ids.map((id) => events.get(id)).filter((e) => e && e.type !== 'screen').map((e) => `    ${describeEvent(e).replace(/^(e\d+) \d\d:\d\d /, '$1 ')}`);
    const go = s.kind === 'go' ? `  Get to: ${destinationText(s.destination)}` : '';
    return [`Step ${i + 1}: ${s.title}`, `  Do: ${s.action}`, go, s.inferred ? '  (Added to fill a gap; not in the recording.)' : '', s.is_judgment && s.reason ? `  Expert's reason: "${s.reason}"` : '', ...s.guardrails.map((g) => `  Guardrail: ${g.text}`), did.length ? '  What the expert did:' : '', ...did]
      .filter(Boolean)
      .join('\n');
  });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 12000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: `Task: ${skill.map.title}\n${skill.map.summary}\n${prerequisitesText(skill.map)}\n\n${steps.join('\n\n')}` }],
  });
  if (response.stop_reason !== 'end_turn') throw new Error(`Couldn't plan the replay (${response.stop_reason}).`);
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const plan = JSON.parse(text);
  // Only keep references to events that exist.
  plan.actions = plan.actions.filter((a) => a.event_id == null || events.has(a.event_id));
  return plan;
}

// Which learned skill (if any) is the user asking for?
// Returns { id, match: 'yes' | 'maybe' | 'no', question }. For 'maybe', question
// is a short yes/no question that checks they mean the learned task.
async function findSkill(apiKey, request, skills, onScreen = '') {
  const none = { id: null, match: 'no', question: '' };
  if (!skills.length) return none;
  const client = new Anthropic({ apiKey });
  const list = skills.map((s) => `- id "${s.id}": ${s.title}${s.summary ? ` — ${s.summary}` : ''}`).join('\n');
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: MATCH_SCHEMA } },
    system: `Match a request to the tasks a helper has learned.
- "yes": the request is clearly that task (different wording is fine).
- "maybe": it could plausibly be that task but something is unclear (it's broader or narrower, or a detail is missing). Write one yes/no question, under 15 words, that checks they mean exactly the learned task, naming its key detail. Example: learned "transcribe a piano piece from a YouTube video in PianoScribe", request "transcribe a YouTube video" -> "Is it a piano piece you want, in PianoScribe?"
- "no": it's a different task. Never stretch a skill to cover something else.
- A vague request ("export this", "do the usual here") is about what's on their screen: prefer the task that fits where they are.
Use question "" unless match is "maybe".`,
    messages: [{ role: 'user', content: `Learned tasks:\n${list}\n\nRequest: "${request}"${onScreen ? `\nOn their screen right now: ${onScreen}` : ''}` }],
  });
  if (response.stop_reason !== 'end_turn') return none;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const r = JSON.parse(text);
    if (r.match === 'no' || !skills.some((s) => s.id === r.skill_id)) return none;
    return { id: r.skill_id, match: r.match, question: r.question };
  } catch {
    return none;
  }
}

const LOCATE_SCHEMA = {
  type: 'object',
  properties: { target_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
  required: ['target_id'],
  additionalProperties: false,
};

// For a task it hasn't learned: is there one thing on screen right now whose
// label clearly does it in a single click? Returns that element or null. It
// never plans a route; that's what learned skills are for.
async function locateTarget(apiKey, request, elements) {
  const screen = describeScreen(elements);
  if (!screen.chosen.length) return null;
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: LOCATE_SCHEMA } },
    system: 'Pick the one element on screen whose label clearly does what the user asks, in a single click (for "how do I export this", a button labelled Export). Only pick something visible in the list. If nothing on screen clearly does it in one click, return null. Never guess at a route or a hidden menu.',
    messages: [{ role: 'user', content: `Request: "${request}"\n\nOn screen (id | role | "label" | app | x,y):\n${screen.text}` }],
  });
  if (response.stop_reason !== 'end_turn') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const { target_id: id } = JSON.parse(text);
    return Number.isInteger(id) ? screen.chosen[id] || null : null;
  } catch {
    return null;
  }
}

class Guide {
  // skill: { id, map, session } from a recorded teaching session.
  constructor(apiKey, skill) {
    this.client = new Anthropic({ apiKey });
    this.skill = skill;
    this.messages = [];
    this.chosen = [];
    this.steps = 0;
    this.goal = '';
    this.inFlight = false;
  }

  static available(cfg) {
    return Boolean(cfg.anthropicApiKey);
  }

  get totalSteps() {
    return this.skill.map.steps.length;
  }

  // First turn: the learned Work Map, the request, and what's on screen.
  start(goal, scan, note = '') {
    this.goal = goal;
    return this.turn(`${describeSkill(this.skill)}\n\nThe user asked: "${goal}"\nFront app: ${scan.app}${note ? `\n\n${note}` : ''}`, scan);
  }

  // Later turns: what happened, then the fresh screen.
  next(scan, note) {
    return this.turn(note, scan);
  }

  // Turns must not overlap: each one appends to the same history, and Claude
  // rejects a conversation whose earlier messages changed under it.
  async turn(intro, scan) {
    if (this.inFlight) throw Object.assign(new Error('A step is already in progress.'), { busy: true });
    this.inFlight = true;
    try {
      return await this.runTurn(intro, scan);
    } finally {
      this.inFlight = false;
    }
  }

  async runTurn(intro, scan) {
    if (this.steps >= MAX_STEPS) {
      return { status: 'stuck', say: "That's taking a lot of steps. Let's stop here; ask me again if you need more help." };
    }
    this.steps++;

    const screen = describeScreen(scan.elements);
    this.chosen = screen.chosen;
    this.messages.push({ role: 'user', content: `${intro}\n\nOn screen now:\n${screen.text}` });

    let response;
    try {
      response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // Keep it snappy: this is a live UI, and finding the next click is light reasoning.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: this.messages,
      });
    } catch (err) {
      this.messages.pop(); // keep the history valid for a retry
      this.steps--;
      throw describeError(err);
    }

    // Keep the full content (including thinking blocks) so the next turn continues cleanly.
    this.messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return { status: 'stuck', say: "Sorry, I can't help with that one." };
    }
    if (response.stop_reason === 'max_tokens') {
      return { status: 'stuck', say: 'I lost my train of thought. Could you ask me again?' };
    }

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let step;
    try {
      step = JSON.parse(text);
    } catch {
      return { status: 'stuck', say: 'I got confused there. Could you ask me again?' };
    }

    const target = Number.isInteger(step.target_id) ? this.chosen[step.target_id] || null : null;
    const stepNumber = Number.isInteger(step.step_number) ? step.step_number : null;
    return { status: step.status, say: step.say, target, stepNumber };
  }
}

function describeError(err) {
  let say = "I couldn't reach my brain just now. Try again in a moment.";
  if (err instanceof Anthropic.AuthenticationError) say = 'My Anthropic API key looks wrong. Check ANTHROPIC_API_KEY in the .env file.';
  else if (err instanceof Anthropic.RateLimitError) say = "I'm being rate limited. Give me a minute and ask again.";
  else if (err instanceof Anthropic.BadRequestError) say = 'Something about that request was off. Try asking a different way.';
  console.error('[guide]', err.status || '', err.message);
  return Object.assign(new Error(err.message), { say });
}

module.exports = { Guide, describeScreen, describeSkill, findSkill, planReplay, locateTarget, destinationText };
