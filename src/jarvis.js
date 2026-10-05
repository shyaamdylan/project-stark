// Jarvis: does a learned task for the user instead of teaching it.
//
// Friday turns an expert's demonstration into a Work Map and a replay plan (the
// clean list of clicks, edits and shortcuts; see guide.js). Jarvis carries out
// that same list on the user's screen. Before he starts, Claude reads the skill
// once and works out which values are fixed (the expert always sets "Currency"
// to EUR) and which change from case to case (which invoice, which amount), so
// Jarvis can ask the user for exactly those.
//
// Safety is the point of this file:
// - He only ever does a skill he was taught; he never improvises a procedure.
// - He says what he's about to do and waits for a yes before touching anything.
// - Anything hard to undo (send, delete, pay, submit…), or a step where the
//   expert said to stop and ask, needs its own yes, every time.
// - He never types passwords, card numbers or codes; he hands those to you.
// - If he can't find something, he asks you to click it rather than guessing.
// - Esc, "stop", clicking the orb, or clicking anywhere yourself stops him at once.
// - Every action is logged next to the skill (runs/<time>.json).

const { Anthropic } = require('@anthropic-ai/sdk');
const { describeEvent } = require('./apprentice');
const { findBest, normalize } = require('./matcher');
const { locate } = require('./replay');
const { parseShortcut } = require('./act');

const MODEL = 'claude-opus-5-5';

const FIND_MS = 6000; // keep looking for a target this long before asking the user
const SCROLL_AFTER_MS = 2200; // haven't found it by waiting this long: try scrolling, like a person would
const MAX_SCROLLS = 3; // per target, before giving up to a hand-off
const SCROLL_LINES = -12; // negative: scroll down, to reveal what's below
const AIM_MS = 650; // let the orb's cursor arrive before clicking, so you can see what he's doing
const SETTLE_MS = 700; // give the app a moment to react after each action
const LOOK_MS = 1500;
const HANDOFF_MS = 90000; // how long to wait for the user to do something for him
const ASSIST_GRACE_MS = 10000; // after a hand-off click, more clicks for that same episode don't stop him
const MAX_RUN_MS = 15 * 60 * 1000;

// ---------- safety rules (pure, tested) ----------

// Buttons whose effect is hard to take back or reaches other people.
const RISKY_LABEL = /\b(send|delete|remove|erase|trash|empty|pay|payment|purchase|buy|order|checkout|check out|submit|transfer|wire|publish|post|share|sign|approve|confirm|accept|reject|decline|unsubscribe|deactivate|close account|log ?out|sign ?out|quit|shut ?down|restart|format|overwrite|replace|discard|revoke|merge|deploy|book|reserve|invite|archive|forward|reply all|install|uninstall|reset)\b/i;

// Shortcuts that quit, delete or send.
const RISKY_KEYS = new Set(['⌘Q', '⌥⌘Q', '⌘Backspace', '⌘Delete', '⇧⌘Backspace', '⌥⇧⌘Backspace', '⌘Enter', '⇧⌘D', '⇧⌘Q', '⌥⌘Escape']);

// Fields he won't fill in himself.
const SENSITIVE_FIELD = /pass(word|code|phrase)?\b|\bpin\b|cvv|cvc|security code|card number|credit card|\bssn\b|social security|secret|token|api key|2fa|one[- ]time|\botp\b|verification code|auth(entication)? code|iban|routing number|account number/i;

function riskOf(action) {
  if (!action) return null;
  if (action.kind === 'shortcut' && RISKY_KEYS.has(action.keys)) return `press ${spokenKeys(action.keys)}`;
  if ((action.kind === 'click' || action.kind === 'choose') && action.label && RISKY_LABEL.test(action.label)) return `click "${action.label}"`;
  return null;
}

const isSensitiveField = (label) => SENSITIVE_FIELD.test(String(label || ''));

// A search or address bar does nothing until you press Return -- basic
// computer use a person doesn't need telling, so Jarvis does it unprompted
// after typing into one, rather than only when the recording happened to
// capture the keystroke. Safari's own address bar reports as a plain
// AXTextField labelled "smart search field", not AXSearchField, hence the
// label check as well as the role.
const SEARCH_LIKE_LABEL = /\bsearch\b|\baddress\b|\burl\b|smart search field/i;
const isSearchLikeField = (role, label) => role === 'AXSearchField' || SEARCH_LIKE_LABEL.test(String(label || ''));

// The middle of what's currently on screen -- a reasonable place to point the
// scroll wheel when nothing in particular tells us which panel scrolls.
function contentPoint(elements) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of elements) {
    minX = Math.min(minX, e.x);
    minY = Math.min(minY, e.y);
    maxX = Math.max(maxX, e.x + e.w);
    maxY = Math.max(maxY, e.y + e.h);
  }
  return Number.isFinite(minX) ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
}

const KEY_WORDS = { '⌘': 'Command ', '⌃': 'Control ', '⌥': 'Option ', '⇧': 'Shift ' };
function spokenKeys(keys) {
  return String(keys || '').replace(/[⌘⌃⌥⇧]/g, (k) => KEY_WORDS[k]).trim();
}

// Only a clear yes counts. Anything else (silence, "hmm", "wait") is a no.
//
// People answer with an interjection before the actual yes ("Perfect, go for
// it.", "Great, do it.", "Sounds good, proceed."), so the affirmative phrase
// only needs to start a clause (the beginning of the answer, or right after
// a ., ! or ,) rather than the whole answer. The negation check still scans
// the entire answer, so a hedge anywhere ("yes but don't send it") still wins.
function isYes(text) {
  const t = String(text || '').trim().toLowerCase().replace(/^(?:jarvis|um+|uh+|well|so)[\s,.!]+/, '');
  if (/\b(no|not|don'?t|stop|wait|cancel|hold)\b/.test(t)) return false;
  const CLAUSE = /(?:^|[.,!;]\s*)(yes|yeah|yep|yup|sure|correct|right|ok(ay)?|go( ahead)?|proceed|do it|carry on|continue|please( do)?|affirmative|absolutely|of course|very well|make it so|go for it|sounds good|that'?s (fine|right|it)|perfect|great|brilliant|lovely|excellent|awesome|fantastic|wonderful)\b/;
  return CLAUSE.test(t);
}

// Loose comparison of what a field shows with what we typed ("1,000.00" vs "1000").
function sameValue(shown, wanted) {
  const a = normalize(String(shown ?? ''));
  const b = normalize(String(wanted ?? ''));
  if (a === b) return true;
  const digits = (x) => x.replace(/[^0-9]/g, '').replace(/0+$/, '');
  if (/\d/.test(b) && digits(a) && digits(a) === digits(b)) return true;
  return Boolean(b) && a.includes(b);
}

const TEXT_ROLES = new Set(['AXTextField', 'AXSearchField', 'AXComboBox', 'AXTextArea']);
const TOGGLE_ROLES = new Set(['AXCheckBox', 'AXRadioButton']);
const PICKABLE = new Set(['AXButton', 'AXLink', 'AXRow', 'AXCell', 'AXStaticText', 'AXImage', 'AXMenuItem', 'AXTab', 'AXRadioButton', 'AXCheckBox', 'AXPopUpButton', 'AXMenuButton', 'AXDockItem']);

// ---------- planning with Claude ----------

const ROLE_WORDS = {
  AXButton: 'button', AXMenuButton: 'menu button', AXPopUpButton: 'dropdown', AXLink: 'link', AXTab: 'tab',
  AXRadioButton: 'option', AXCheckBox: 'checkbox', AXMenuBarItem: 'menu', AXMenuItem: 'menu item',
  AXSearchField: 'search field', AXTextField: 'field', AXTextArea: 'text area', AXComboBox: 'field',
  AXSlider: 'slider', AXCell: 'cell', AXRow: 'row',
};

function describeAction(a, i) {
  const what = ROLE_WORDS[a.role] || 'item';
  let line;
  switch (a.kind) {
    case 'click': line = `click ${what} "${a.label}"`; break;
    case 'edit': line = `set ${what} "${a.label}" (the expert entered "${a.value ?? ''}")`; break;
    case 'shortcut': line = `press ${a.keys}`; break;
    case 'choose': case 'any-click': line = `pick the case-specific item${a.say ? ` (${a.say})` : ''}`; break;
    default: line = `wait / check${a.say ? ` (${a.say})` : ''}`;
  }
  return `a${i} step ${a.stepIndex + 1}: ${line}`;
}

function describeSkillForJarvis(skill, actions) {
  const { map, session } = skill;
  const events = new Map((session.events || []).map((e) => [e.id, e]));
  const steps = map.steps.map((s, i) => {
    const lines = [`Step ${i + 1}: ${s.title}`, `  Do: ${s.action}`];
    if (s.decision) lines.push(`  Decision: ${s.decision}`);
    if (s.reason) lines.push(`  Expert's reason: "${s.reason}"`);
    if (s.rule) lines.push(`  Rule: ${s.rule}`);
    for (const g of s.guardrails) lines.push(`  Guardrail (${g.kind.replace(/_/g, ' ')}): ${g.text}`);
    const said = s.event_ids.map((id) => events.get(id)).filter((e) => e && e.type === 'say').map((e) => `  ${describeEvent(e).replace(/^e\d+ \d\d:\d\d /, '')}`);
    return lines.concat(said).join('\n');
  });
  return `Task: ${map.title}\n${map.summary}\n\n${steps.join('\n\n')}\n\nActions you will perform, in order:\n${actions.map(describeAction).join('\n')}`;
}

function planSystem(address) {
  const addr = String(address || '').trim();
  return `You are J.A.R.V.I.S., the calm, capable AI butler from Iron Man: polite, unflappable, concise, with a dry British wit. ${addr ? `You address the user as "${addr}", now and then, not in every line.` : 'You never use a form of address like sir or madam.'}

You are about to carry out a task on the user's Mac for them by clicking and typing. You may only follow the procedure an expert taught (the Work Map below); never add steps.

Work out:
- can_run: false if this can't be done safely by clicking and typing for the user: it needs a physical action, signing in, passwords or payment details, or a judgment call that has no stated rule and no value the user could simply give you. why_not: one sentence, in character, saying why (else "").
- inputs: what you must ask the user before starting because it's specific to this case: which item to pick, a value that changes each time, or the outcome of a judgment step. Each is one short spoken question, in character, under 22 words. For a judgment step, ask for the value and briefly mention the expert's rule so the user can decide. Never ask for passwords, card numbers or codes. Use ids like "i1". Keep it to what's truly needed; none is fine.
- actions: exactly one entry per action, by index. For an "edit": value_from "recorded" when the expert's value would be the same every time (a fixed setting), or "input" with input_id when it depends on the case. For a "pick the case-specific item" action: value_from "input" with the input_id that says what to pick. Otherwise value_from "none" and input_id null.
  confirm: true for anything hard to undo or that affects other people (sending, submitting, paying, deleting, publishing, approving), and where a guardrail says to stop and ask. confirm_line: the spoken check, in character, ending in a question (else "").
- step_lines: one per Work Map step, in order: a few words you say as you start it, in character ("Opening the File menu.").
- summary: what you're about to do, in character, one sentence under 25 words, no question.

Everything is spoken aloud: no markdown, ids or symbols.`;
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    can_run: { type: 'boolean' },
    why_not: { type: 'string' },
    summary: { type: 'string' },
    inputs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, question: { type: 'string' } },
        required: ['id', 'question'],
        additionalProperties: false,
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          value_from: { type: 'string', enum: ['none', 'recorded', 'input'] },
          input_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confirm: { type: 'boolean' },
          confirm_line: { type: 'string' },
        },
        required: ['index', 'value_from', 'input_id', 'confirm', 'confirm_line'],
        additionalProperties: false,
      },
    },
    step_lines: { type: 'array', items: { type: 'string' } },
  },
  required: ['can_run', 'why_not', 'summary', 'inputs', 'actions', 'step_lines'],
  additionalProperties: false,
};

// Make the plan safe to use whatever came back: one entry per action, inputs
// that exist, and a case-specific pick always tied to an input.
function normalizePlan(raw, actions) {
  const inputs = (raw.inputs || []).filter((x) => x && x.id && x.question);
  const ids = new Set(inputs.map((x) => x.id));
  const byIndex = new Map((raw.actions || []).map((a) => [a.index, a]));
  const planned = actions.map((a, i) => {
    const p = byIndex.get(i) || {};
    let from = ['none', 'recorded', 'input'].includes(p.value_from) ? p.value_from : 'none';
    let inputId = from === 'input' && ids.has(p.input_id) ? p.input_id : null;
    if (from === 'input' && !inputId) from = a.kind === 'edit' ? 'recorded' : 'none';
    if (a.kind === 'edit' && from === 'none') from = 'recorded';
    return { value_from: from, input_id: inputId, confirm: Boolean(p.confirm), confirm_line: p.confirm_line || '' };
  });
  return {
    can_run: raw.can_run !== false,
    why_not: raw.why_not || '',
    summary: raw.summary || '',
    inputs,
    actions: planned,
    step_lines: Array.isArray(raw.step_lines) ? raw.step_lines : [],
  };
}

async function planRun(apiKey, skill, actions, address) {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    system: planSystem(address),
    messages: [{ role: 'user', content: describeSkillForJarvis(skill, actions) }],
  });
  if (response.stop_reason === 'refusal') return normalizePlan({ can_run: false, why_not: "I'm afraid I can't do that one." }, actions);
  if (response.stop_reason !== 'end_turn') throw new Error(`Couldn't plan the run (${response.stop_reason}).`);
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalizePlan(JSON.parse(text), actions);
}

// ---------- carrying it out ----------

class Stopped extends Error {}

class JarvisRun {
  // deps:
  //   skill     { map, session }
  //   actions   from buildActions (replay.js)
  //   plan      from planRun
  //   s(line)   fills in the form of address ("Right away{sir}.")
  //   scan()    front-window scan
  //   act       { click(rect), type(text), keys(spec), selectAll(), escape() }
  //   ask(text, phase) -> the user's answer ('' if skipped or cancelled)
  //   emit(ev)  { type: 'step' | 'point' | 'say', say, stepNo, totalSteps, target }
  //   wait(ms)  (tests pass a fast one, and a short findMs)
  constructor({ skill, actions, plan, s = (x) => x.replace(/\{sir\}/g, ''), scan, act, ask, emit = () => {}, wait, findMs = FIND_MS }) {
    this.findMs = findMs;
    this.skill = skill;
    this.actions = actions;
    this.plan = plan;
    this.s = s;
    this.scanFn = scan;
    this.act = act;
    this.askFn = ask;
    this.emit = emit;
    this.waitFn = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Live from the start, so a stop that comes before run() still counts.
    this.running = true;
    this.startedAt = Date.now();
    this.acting = false; // our own input events are in flight
    this.actedAt = 0;
    this.handoff = null; // resolves when the user clicks for us
    this.assistUntil = 0; // while true, clicks continue the hand-off episode rather than stopping him
    this.asking = false; // waiting on the user's answer: they may click around to check something
    this.executing = false; // past the go-ahead, doing the steps
    this.inputs = {};
    this.log = [];
    this.latest = null;
    this.stopReason = '';
  }

  get total() {
    return this.skill.map.steps.length;
  }

  record(entry) {
    this.log.push({ t: Date.now() - this.startedAt, ...entry });
  }

  // Esc, "stop", the orb, or the user taking the mouse.
  stop(reason = 'stopped') {
    if (!this.running) return;
    this.running = false;
    this.stopReason = reason;
    this.record({ kind: 'stop', detail: reason });
    if (this.handoff) this.handoff(false);
  }

  // A real mouse click from the user (main.js filters out clicks on the orb).
  onUserClick() {
    if (!this.running) return;
    if (this.handoff) return this.handoff(true);
    if (this.asking || !this.executing) return;
    // Our own clicks show up here too; ignore anything just after we acted.
    if (this.acting || Date.now() - this.actedAt < 500) return;
    // Finding and clicking the one thing he handed off is rarely a single
    // click in real apps (search, then pick a result; follow a link, then
    // scroll to the right spot). Keep treating clicks as that same hand-off
    // for a while after the first one, sliding the window with each click,
    // instead of reading every one of them as "you've taken over, I'll stop."
    if (Date.now() < this.assistUntil) {
      this.assistUntil = Date.now() + ASSIST_GRACE_MS;
      return;
    }
    this.stop('user-click');
  }

  // Esc. Ignored only while we're pressing Esc ourselves (closing a list).
  onEscape() {
    if (!this.running || this.acting || Date.now() - this.actedAt < 500) return;
    this.stop('escape');
  }

  check() {
    if (!this.running) throw new Stopped(this.stopReason);
    if (Date.now() - this.startedAt > MAX_RUN_MS) {
      this.stop('timeout');
      throw new Stopped('timeout');
    }
  }

  async wait(ms) {
    await this.waitFn(ms);
    this.check();
  }

  async ask(text, phase) {
    this.check();
    this.asking = true;
    let answer;
    try {
      answer = await this.askFn(text, phase);
    } finally {
      this.asking = false;
    }
    this.check();
    return String(answer || '').trim();
  }

  async confirm(text) {
    return isYes(await this.ask(text, 'jarvis-confirm'));
  }

  async scan() {
    const s = await this.scanFn();
    this.check();
    if (s && !s.error) this.latest = s;
    return this.latest;
  }

  async doAct(fn) {
    this.check();
    this.acting = true;
    try {
      await fn();
    } finally {
      this.acting = false;
      this.actedAt = Date.now();
    }
    this.check();
  }

  // Look for an action's element, rescanning while the app catches up. A
  // scrollable list only shows what's currently in view (see list-elements.js),
  // so something not on screen yet may just be further down -- a person would
  // scroll before giving up, so try that too before asking for help.
  async find(action, pick = locate) {
    const until = Date.now() + this.findMs;
    let nextScrollAt = Date.now() + SCROLL_AFTER_MS;
    let scrolls = 0;
    for (;;) {
      const s = await this.scan();
      const el = s ? pick(action, s.elements) : null;
      if (el && !el.hidden) return el;
      if (Date.now() > until) return null;
      if (this.act.scroll && scrolls < MAX_SCROLLS && Date.now() >= nextScrollAt) {
        const at = s ? contentPoint(s.elements) : null;
        if (at) {
          await this.doAct(() => this.act.scroll(at, SCROLL_LINES));
          this.record({ kind: 'scroll', detail: `looking for "${action.label || ''}"` });
          scrolls++;
          nextScrollAt = Date.now() + SCROLL_AFTER_MS;
          continue; // look again right away rather than waiting it out
        }
      }
      await this.wait(500);
    }
  }

  // Ask the user to do one thing for us, then carry on when they click.
  async handOff(line) {
    this.emit({ type: 'say', say: this.s(line) });
    this.record({ kind: 'handoff', detail: line });
    const clicked = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), HANDOFF_MS);
      this.handoff = (v) => {
        clearTimeout(t);
        this.handoff = null;
        resolve(v);
      };
    });
    this.check();
    if (!clicked) {
      this.stop('handoff-timeout');
      this.check();
    }
    this.assistUntil = Date.now() + ASSIST_GRACE_MS;
    await this.wait(SETTLE_MS);
  }

  // Point the orb's cursor at the target, give it a moment to arrive, then click.
  async clickOn(el, what) {
    this.emit({ type: 'point', target: el });
    await this.wait(AIM_MS);
    await this.doAct(() => this.act.click(el));
    this.record({ kind: 'click', label: el.label, role: el.role, detail: what });
    await this.wait(SETTLE_MS);
  }

  async run() {
    this.startedAt = Date.now();
    try {
      this.check();
      return await this.runInner();
    } catch (err) {
      if (err instanceof Stopped) return { status: 'stopped', reason: this.stopReason, say: this.stopLine() };
      this.running = false;
      this.record({ kind: 'error', detail: err.message });
      const say = err.code === 'ACCESSIBILITY' || err.code === 'AUTOMATION'
        ? this.s("I'm afraid macOS won't let me use the keyboard and mouse yet. Please allow it in Privacy and Security{sir}.")
        : this.s("Something went wrong on my end{sir}, so I've stopped. Nothing further was touched.");
      return { status: 'error', reason: err.code || 'error', error: err, say };
    } finally {
      this.running = false;
    }
  }

  stopLine() {
    switch (this.stopReason) {
      case 'user-click': return this.s('You have the controls{sir}. Standing down.');
      case 'declined': return this.s('Very good. I shall leave it there.');
      case 'timeout': return this.s("That's taking far longer than it should, so I've stopped.");
      case 'handoff-timeout': return this.s("I'll stand by. Ask again whenever you're ready.");
      // Stopped because something else is happening now: nothing to announce.
      case 'new-request': case 'switch': case 'teach': case 'quit': return '';
      default: return this.s('Stopped{sir}.');
    }
  }

  async runInner() {
    const { plan } = this;
    if (!plan.can_run) {
      this.running = false;
      return { status: 'declined', say: plan.why_not || this.s("I'm afraid that one needs a human touch{sir}.") };
    }

    // 1. Ask for what's specific to this case.
    for (const input of plan.inputs) {
      const answer = await this.ask(input.question, 'jarvis-input');
      if (!answer) {
        this.stop('declined');
        this.check();
      }
      this.inputs[input.id] = answer.replace(/[.!?]+$/, '');
      this.record({ kind: 'input', detail: input.question, value: this.inputs[input.id] });
    }

    // 2. Say what he's about to do and wait for a yes.
    const summary = plan.summary || `I'll ${this.skill.map.title.toLowerCase()}.`;
    if (!(await this.confirm(`${summary} ${this.s('Shall I proceed{sir}?')}`))) {
      this.stop('declined');
      this.check();
    }

    // 3. Do it.
    this.executing = true;
    let lastStep = -1;
    for (let i = 0; i < this.actions.length; i++) {
      this.check();
      const a = this.actions[i];
      const p = plan.actions[i];
      if (a.stepIndex !== lastStep) {
        lastStep = a.stepIndex;
        this.emit({ type: 'step', say: plan.step_lines[a.stepIndex] || this.skill.map.steps[a.stepIndex].title, stepNo: a.stepIndex + 1, totalSteps: this.total });
      }
      await this.checkpoint(a, p, i);
      await this.perform(a, p, i);
    }
    this.running = false;
    return { status: 'done', say: this.s(`All done{sir}. ${this.skill.map.title} is complete.`) };
  }

  // Ask for a yes before anything risky, and wherever the expert said to stop and ask.
  async checkpoint(a, p, i) {
    const step = this.skill.map.steps[a.stepIndex];
    const reasons = [];
    const risky = riskOf(a);
    if (risky) reasons.push(risky);
    const stopAndAsk = a.first ? step.guardrails.filter((g) => g.kind === 'stop_and_ask') : [];
    if (!p.confirm && !risky && !stopAndAsk.length) return;
    let line = p.confirm && p.confirm_line ? p.confirm_line : '';
    if (!line && stopAndAsk.length) line = `The expert says: ${stopAndAsk.map((g) => g.text).join(' ')} ${this.s('Shall I carry on{sir}?')}`;
    if (!line) line = `I'm about to ${risky || 'carry out the next step'}. ${this.s('Shall I go ahead{sir}?')}`;
    else if (risky && !/\?\s*$/.test(line)) line = `${line} ${this.s('Shall I go ahead{sir}?')}`;
    const ok = await this.confirm(line);
    this.record({ kind: 'confirm', detail: line, value: ok ? 'yes' : 'no', action: i });
    if (!ok) {
      this.stop('declined');
      this.check();
    }
  }

  valueFor(a, p) {
    if (p.value_from === 'input' && p.input_id) return this.inputs[p.input_id] ?? '';
    return a.value ?? '';
  }

  async perform(a, p, i) {
    switch (a.kind) {
      case 'click': return this.doClick(a);
      case 'edit': return this.doEdit(a, p, i);
      case 'shortcut': return this.doShortcut(a);
      case 'choose':
      case 'any-click': return this.doChoose(a, p);
      default:
        this.record({ kind: 'look', detail: a.say || '' });
        return this.wait(LOOK_MS);
    }
  }

  async doClick(a) {
    const el = await this.find(a);
    if (!el) return this.handOff(`I can't find "${a.label}" on screen{sir}. Would you click it for me? I'll take it from there.`);
    await this.clickOn(el, 'click');
  }

  async doShortcut(a) {
    const spec = parseShortcut(a.keys);
    if (!spec) return this.handOff(`Would you press ${spokenKeys(a.keys)} for me{sir}? I'll carry on after your next click.`);
    await this.doAct(() => this.act.keys(spec));
    this.record({ kind: 'keys', detail: a.keys });
    await this.wait(SETTLE_MS);
  }

  async doChoose(a, p) {
    const want = p.input_id ? this.inputs[p.input_id] : '';
    if (want) {
      const pick = (_a, elements) => {
        const options = elements.filter((e) => PICKABLE.has(e.role) && !e.hidden);
        const best = findBest(want, options);
        return best.match && best.score >= 0.75 ? best.match : null;
      };
      const el = await this.find(a, pick);
      if (el) {
        // The user named it, but a risky-looking item still gets a check.
        if (RISKY_LABEL.test(el.label) && !(await this.confirm(`That's labelled "${el.label}". ${this.s('Shall I click it{sir}?')}`))) {
          this.stop('declined');
          this.check();
        }
        return this.clickOn(el, `choose "${want}"`);
      }
    }
    const what = want ? `"${want}"` : 'the right one';
    return this.handOff(`I can't pick out ${what} with confidence{sir}. Would you click it for me? I'll carry on from there.`);
  }

  async doEdit(a, p, i) {
    if (isSensitiveField(a.label)) {
      // Never typed by Jarvis. The user fills it in and says when they're done.
      const answer = await this.ask(this.s(`I'll leave "${a.label}" to you{sir}; I don't type those. Fill it in, then say done.`), 'jarvis-input');
      this.record({ kind: 'sensitive', label: a.label, detail: answer ? 'user filled it in' : 'skipped' });
      if (!answer) {
        this.stop('declined');
        this.check();
      }
      return;
    }
    const value = this.valueFor(a, p);
    const el = await this.find(a);
    if (!el) return this.handOff(`I can't find the "${a.label}" field{sir}. Would you click on it for me?`);

    if (TOGGLE_ROLES.has(a.role)) {
      const want = String(value) === '1' ? '1' : '0';
      if (String(el.value) !== want) await this.clickOn(el, `set to ${want === '1' ? 'on' : 'off'}`);
      else this.record({ kind: 'edit', label: a.label, detail: 'already set' });
      return;
    }

    if (a.role === 'AXPopUpButton') {
      if (sameValue(el.value, value)) return this.record({ kind: 'edit', label: a.label, detail: 'already set' });
      await this.clickOn(el, 'open');
      const item = await this.find({ label: String(value), role: 'AXMenuItem' });
      if (!item) {
        await this.doAct(() => this.act.escape());
        return this.handOff(`I can't see "${value}" in that list{sir}. Would you choose it for me?`);
      }
      return this.clickOn(item, `choose "${value}"`);
    }

    if (!TEXT_ROLES.has(a.role)) return this.handOff(`Would you set "${a.label}" to ${value} for me{sir}? I'll carry on after you click.`);

    await this.clickOn(el, 'focus');
    await this.doAct(async () => {
      await this.act.selectAll();
      await this.act.type(String(value));
    });
    this.record({ kind: 'edit', label: a.label, value: String(value) });
    await this.wait(SETTLE_MS);

    // Check it took.
    const s = await this.scan();
    const after = s ? locate(a, s.elements) : null;
    if (after && 'value' in after && !sameValue(after.value, value)) {
      const ok = await this.confirm(`The ${a.label} field shows "${after.value}" rather than "${value}". ${this.s('Shall I carry on regardless{sir}?')}`);
      if (!ok) {
        this.stop('declined');
        this.check();
      }
    }

    // Basic computer sense: a search or address bar does nothing until you
    // press Return. Skip it only if the very next recorded action already
    // presses Return itself, so a taught Enter keystroke is never doubled up.
    const next = i != null ? this.actions[i + 1] : null;
    const alreadyPressesReturn = next && next.kind === 'shortcut' && /^(enter|return)$/i.test(String(next.keys || ''));
    if (!alreadyPressesReturn && isSearchLikeField(a.role, a.label)) {
      const spec = parseShortcut('Enter');
      await this.doAct(() => this.act.keys(spec));
      this.record({ kind: 'keys', detail: 'Enter', note: 'pressed automatically to submit the search' });
      await this.wait(SETTLE_MS);
    }
  }
}

module.exports = { JarvisRun, planRun, normalizePlan, riskOf, isSensitiveField, isSearchLikeField, isYes, sameValue, describeSkillForJarvis, spokenKeys };
