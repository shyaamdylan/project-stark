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
const { locate, atDestination, nextTargetVisible } = require('./replay');
const { parseShortcut } = require('./act');
const { forksOf, progress } = require('./forks');

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
const ARRIVE_MS = 15000; // after opening a site or app, how long to wait for it to show up
const MAX_RUN_MS = 15 * 60 * 1000;

// ---------- safety rules (pure, tested) ----------

// Buttons whose effect is hard to take back or reaches other people.
const RISKY_LABEL = /\b(send|delete|remove|erase|trash|empty|pay|payment|purchase|buy|order|checkout|check out|submit|transfer|wire|publish|post|share|sign|approve|confirm|accept|reject|decline|unsubscribe|deactivate|close account|log ?out|sign ?out|quit|shut ?down|restart|format|overwrite|replace|discard|revoke|merge|deploy|book|reserve|invite|archive|forward|reply all|install|uninstall|reset)\b/i;

// Shortcuts that quit, delete or send.
const RISKY_KEYS = new Set(['⌘Q', '⌥⌘Q', '⌘Backspace', '⌘Delete', '⇧⌘Backspace', '⌥⇧⌘Backspace', '⌘Enter', '⇧⌘D', '⇧⌘Q', '⌥⌘Escape']);

// Fields he won't fill in himself.
const SENSITIVE_FIELD = /pass(word|code|phrase)?\b|\bpin\b|cvv|cvc|security code|card number|credit card|\bssn\b|social security|secret|token|api key|2fa|one[- ]time|\botp\b|verification code|auth(entication)? code|iban|routing number|account number/i;

// Return in a field sends or submits what's in it (a message, a comment, a
// form), except in a search or address bar, where it just searches.
const RETURN_KEY = /^(?:return|enter|↩|⏎)$/i;

// What would make this action hard to take back, or null. focused: the field
// the keyboard is in ({ role, label, value }), when known.
function riskOf(action, focused = null) {
  if (!action) return null;
  if (action.kind === 'shortcut' && RISKY_KEYS.has(action.keys)) return `press ${spokenKeys(action.keys)}`;
  if (action.kind === 'shortcut' && RETURN_KEY.test(String(action.keys || '').trim()) && focused && /field|text|combo/i.test(focused.role || '') && !isSearchLikeField(focused.role, focused.label)) {
    const what = String(focused.value || '').trim();
    return `send ${what ? `"${what.length > 120 ? `${what.slice(0, 119)}…` : what}"` : 'what\'s in'} ${focused.label ? `from "${focused.label}"` : 'that box'}`;
  }
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
    case 'go': line = `get to ${a.destination ? `${a.destination.name}${a.destination.url ? ` (${a.destination.url})` : ''}` : 'the next screen'} (skipped if already there; needs no input)`; break;
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
    if (s.only_if) lines.push(`  Only if they want ${s.only_if} (one option at a fork)`);
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
- Steps marked "Only if they want …" are one option at a fork. Whether to do them is settled separately before you start (from the request, or a yes/no question), so never ask about that in inputs; plan their actions like any others.
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
  //   act       { click(rect), type(text), keys(spec), selectAll(), escape(),
  //               openUrl(url), openApp(name) -> true if found,
  //               openFile(query) -> name or null, switchTo(query) -> description or null }
  //   ask(text, phase) -> the user's answer ('' if skipped or cancelled)
  //   emit(ev)  { type: 'step' | 'point' | 'say', say, stepNo, totalSteps, target }
  //   wait(ms)  (tests pass a fast one, and a short findMs)
  //   forks     Map option -> 'take' | 'leave' | 'ask' (decideForks, src/forks.js);
  //             options missing or 'ask' are asked as a yes/no before starting
  constructor({ skill, actions, plan, forks = new Map(), s = (x) => x.replace(/\{sir\}/g, ''), scan, act, ask, emit = () => {}, wait, findMs = FIND_MS }) {
    this.forks = forks;
    this.skipped = new Set(); // steps of options not taken
    this.chosen = new Set();
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
    this.userDriving = false; // he asked the user to bring something up: their clicks are expected
    this.index = 0;
    this.inputs = {};
    this.log = [];
    this.latest = null;
    this.stopReason = '';
  }

  get total() {
    return progress(this.skill.map, 0, { skipped: this.skipped, chosen: this.chosen }).of;
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
    if (this.asking || this.userDriving || !this.executing) return;
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

    // 1. Which way at each fork: what they asked for, or a yes/no now.
    for (const { option, steps } of forksOf(this.skill.map)) {
      let take = this.forks.get(option);
      if (take !== 'take' && take !== 'leave') {
        const answer = await this.ask(this.s(`Would you like ${option} as well{sir}?`), 'jarvis-input');
        take = isYes(answer) ? 'take' : 'leave';
        this.record({ kind: 'input', detail: `option: ${option}`, value: answer });
      }
      if (take === 'take') this.chosen.add(option);
      else for (const i of steps) this.skipped.add(i);
    }
    const doing = (i) => !this.skipped.has(this.actions[i].stepIndex);
    // Values only the left-out steps would use aren't asked for.
    const needed = new Set(plan.actions.filter((p, i) => doing(i) && p.input_id).map((p) => p.input_id));

    // 2. Ask for what's specific to this case.
    for (const input of plan.inputs.filter((x) => needed.has(x.id))) {
      const answer = await this.ask(input.question, 'jarvis-input');
      if (!answer) {
        this.stop('declined');
        this.check();
      }
      this.inputs[input.id] = answer.replace(/[.!?]+$/, '');
      this.record({ kind: 'input', detail: input.question, value: this.inputs[input.id] });
    }

    // 3. Say what he's about to do and wait for a yes.
    const summary = plan.summary || `I'll ${this.skill.map.title.toLowerCase()}.`;
    if (!(await this.confirm(`${summary} ${this.s('Shall I proceed{sir}?')}`))) {
      this.stop('declined');
      this.check();
    }

    // 4. Do it.
    this.executing = true;
    let lastStep = -1;
    for (let i = 0; i < this.actions.length; i++) {
      this.check();
      if (!doing(i)) continue;
      this.index = i;
      const a = this.actions[i];
      const p = plan.actions[i];
      if (a.stepIndex !== lastStep) {
        lastStep = a.stepIndex;
        this.emit({ type: 'step', say: plan.step_lines[a.stepIndex] || this.skill.map.steps[a.stepIndex].title, stepNo: progress(this.skill.map, a.stepIndex, { skipped: this.skipped, chosen: this.chosen }).n, totalSteps: this.total });
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
    const risky = riskOf(a, this.latest && this.latest.focused);
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
      case 'go': return this.doGo(a);
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

  // Is the user where a "go" step gets to (or is the next thing to click already showing)?
  async isThere(a) {
    const s = await this.scan();
    return Boolean(s && (atDestination(s, a.destination) || nextTargetVisible(this.actions, this.index, s.elements)));
  }

  async waitUntilThere(a, ms) {
    const until = Date.now() + ms;
    for (;;) {
      if (await this.isThere(a)) return true;
      if (Date.now() > until) return false;
      await this.wait(700);
    }
  }

  // Get to a website, app or screen from wherever the user happens to be.
  async doGo(a) {
    const d = a.destination || { name: 'the right screen' };
    if (await this.isThere(a)) return this.record({ kind: 'go', detail: `already at ${d.name}` });
    let opened = false;
    if (d.url && this.act.openUrl) {
      await this.doAct(() => this.act.openUrl(d.url));
      opened = true;
    } else if (d.app && this.act.openApp) {
      await this.doAct(async () => {
        opened = await this.act.openApp(d.app);
      });
    }
    this.record({ kind: 'go', detail: opened ? `opened ${d.url || d.app}` : `asked the user to bring up ${d.name}` });
    if (opened && (await this.waitUntilThere(a, ARRIVE_MS))) return this.wait(SETTLE_MS);

    // Couldn't get there himself: the user brings it up, and he carries on once it's on screen.
    this.emit({ type: 'say', say: this.s(`Would you bring up ${d.name} for me{sir}? I'll carry on as soon as it's on screen.`) });
    this.userDriving = true;
    try {
      if (!(await this.waitUntilThere(a, HANDOFF_MS))) {
        this.stop('handoff-timeout');
        this.check();
      }
    } finally {
      this.userDriving = false;
    }
    await this.wait(SETTLE_MS);
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

// A learned skill, briefly, as reference for a best-effort run.
function relatedText(skill) {
  const { map } = skill;
  const steps = (map.steps || []).map((s, i) => {
    const extra = [s.rule && `Rule: ${s.rule}`, ...(s.guardrails || []).map((g) => `Guardrail: ${g.text}`)].filter(Boolean).join(' ');
    return `${i + 1}. ${s.title}: ${s.action}${extra ? ` (${extra})` : ''}`;
  });
  return `"${map.title}": ${map.summary || ''}\n${steps.join('\n')}`.slice(0, 4000);
}

// ---------- having a go at something he wasn't taught ----------
//
// The same hands and the same safety rules as a learned skill, but each next
// action comes from Claude looking at the screen (src/improvise.js). He says
// up front that he hasn't been taught it, asks for a yes, and stops the moment
// Claude isn't confident ("needs_teaching"), at the start or halfway through.

const { cleanUrl } = require('./apprentice');
const { boxToScreen, elementAtPoint } = require('./vision');
// What counts as something to click when confirming a screenshot location.
const CLICKABLE_HERE = new Set(['AXButton', 'AXMenuButton', 'AXPopUpButton', 'AXLink', 'AXTab', 'AXRadioButton', 'AXCheckBox', 'AXMenuItem', 'AXMenuBarItem', 'AXCell', 'AXRow', 'AXDisclosureTriangle', 'AXComboBox', 'AXTextField', 'AXSearchField', 'AXTextArea', 'AXImage', 'AXStaticText']);
// He never types or presses keys in a terminal: that would be running commands
// on the Mac. Commands a task needs are given to the user to run themselves.
const TERMINALS = /^(Terminal|iTerm2?|Warp|Alacritty|kitty|WezTerm|Ghostty|Hyper)$/i;
const inTerminal = (scan) => TERMINALS.test((scan && scan.app) || '');
const NO_TERMINAL = "Refused: I don't type or press keys in a terminal. Use a run_command step instead.";
const { commandVerdict } = require('./runproject');

class JarvisFreestyle extends JarvisRun {
  // deps as JarvisRun, minus skill/actions/plan, plus:
  //   goal        what the user asked for
  //   improviser  an Improviser in 'do' mode (or a fake in tests)
  //   related     optional: a learned skill that may be this task (a "maybe"
  //               match), given to Claude as an expert's reference
  //   snap(scan)  a screenshot of the front window for each turn, or null
  constructor({ goal, improviser, related = null, history = '', snap = async () => null, ...deps }) {
    super({ skill: { map: { title: goal, steps: [] }, session: { events: [] } }, actions: [], plan: { can_run: true, inputs: [], actions: [], step_lines: [] }, ...deps });
    this.history = history;
    this.snap = snap;
    this.goal = goal;
    this.brain = improviser;
    this.ranAnyway = new Set(); // commands to run even though the project is already up
    this.related = related;
  }

  async runInner() {
    let note = `${this.history ? `Recent conversation (for context):\n${this.history}\n\n` : ''}The user asked: "${this.goal}"`;
    if (this.related) note += `\n\nAn expert taught you a task that may be this one, or close to it. Where it fits, follow its steps and rules rather than improvising:\n${relatedText(this.related)}`;
    let failures = 0;
    let unanswered = 0;
    for (let step = 0; ; step++) {
      this.check();
      const s = await this.scan();
      const image = await this.snap(s || { elements: [] }).catch(() => null);
      this.check();
      const r = await this.brain.next(note, s || { elements: [] }, image);
      r.image = image;
      this.check();
      this.record({ kind: 'think', detail: `${r.status} ${r.kind}${r.target ? ` "${r.target.label}"` : ''}${r.text ? ` ${r.text}` : ''}`, value: r.say });

      if (r.status === 'done') {
        this.running = false;
        return { status: 'done', say: r.say || this.s('Done{sir}.') };
      }
      if (r.status === 'needs_teaching') {
        this.running = false;
        const lead = this.executing ? this.s("I'll stop there{sir}. ") : this.s("I haven't been taught that{sir}. ");
        return { status: 'needs_teaching', say: `${lead}${r.say}`.replace(/\s+/g, ' ').trim() };
      }
      if (r.status === 'need_info') {
        const answer = await this.ask(r.say, 'jarvis-input');
        // No answer isn't a no: he may be able to decide himself. Twice in a row, he stops.
        if (!answer && ++unanswered >= 2) {
          this.stop('declined');
          this.check();
        }
        if (answer) unanswered = 0;
        note = answer
          ? `The user answered: "${answer}"`
          : "The user didn't answer. If it's a choice you can sensibly make yourself, make it and carry on (say what you chose). Otherwise finish with status done, saying in one sentence what you need.";
        continue;
      }

      // Before the first action: say what he's about to try, and get on with
      // it. No up-front "shall I?": anything that matters (risky clicks and
      // keys, every Terminal command, typing into a terminal) gets its own yes.
      if (!this.executing) {
        this.executing = true;
        if (r.summary) this.emit({ type: 'say', say: r.summary });
      }

      // Steps show on screen but aren't spoken: he talks at the start, when he
      // needs something, and when he's done.
      if (r.say) this.emit({ type: 'step', say: r.say, stepNo: step + 1, totalSteps: 0, quiet: true });
      try {
        note = await this.doStep(r);
        failures = 0;
        unanswered = 0;
      } catch (err) {
        if (err instanceof Stopped || err.code) throw err;
        failures++;
        note = `That didn't work: ${err.message}. Look at the screen again.`;
        if (failures >= 2) {
          this.running = false;
          return { status: 'needs_teaching', say: this.s("That isn't going to plan, so I've stopped{sir}. This one is worth teaching properly.") };
        }
      }
    }
  }

  // Carry out one action, with the same checks as a learned skill. Returns
  // what happened, for Claude's next turn.
  async doStep(r) {
    const t = r.target;
    switch (r.kind) {
      case 'click': {
        // Located only on the screenshot: click it only if accessibility
        // confirms a real control at that spot. A guessed position is never clicked.
        if (!t && r.point && r.image) {
          const spot = boxToScreen(r.point, r.image, r.image.frame);
          const under = elementAtPoint(spot, ((this.latest && this.latest.elements) || []).filter((e) => CLICKABLE_HERE.has(e.role)));
          if (!under) {
            this.emit({ type: 'point', target: spot });
            await this.handOff(`I can see "${r.point.label}" but can't be sure of clicking it precisely{sir}. Would you click it for me?`);
            return `The user clicked "${r.point.label}" for you.`;
          }
          this.record({ kind: 'located', detail: `"${r.point.label}" on the screenshot is "${under.label}"` });
          r.target = under;
          return this.doStep(r);
        }
        if (!t) throw new Error('there was nothing to click');
        if (riskOf({ kind: 'click', label: t.label }) && !(await this.confirm(this.s(`That will press "${t.label}". Shall I go ahead{sir}?`)))) {
          this.stop('declined');
          this.check();
        }
        await this.clickOn(t, 'click');
        return `Done: clicked "${t.label}".`;
      }
      case 'type': {
        const text = r.text || '';
        if (t && isSensitiveField(t.label)) {
          const answer = await this.ask(this.s(`I'll leave "${t.label}" to you{sir}; I don't type those. Fill it in, then say done.`), 'jarvis-input');
          if (!answer) {
            this.stop('declined');
            this.check();
          }
          return `The user filled in "${t.label}" themselves.`;
        }
        if (inTerminal(this.latest)) {
          this.record({ kind: 'refused', detail: `type into ${this.latest.app}`, value: text });
          return NO_TERMINAL;
        }
        if (t) await this.clickOn(t, 'focus');
        await this.doAct(async () => {
          if (t) await this.act.selectAll();
          await this.act.type(text);
        });
        this.record({ kind: 'type', label: t ? t.label : '(focused field)', value: text });
        await this.wait(SETTLE_MS);
        return `Done: typed "${text}"${t ? ` into "${t.label}"` : ''}.`;
      }
      case 'keys': {
        if (inTerminal(this.latest)) {
          this.record({ kind: 'refused', detail: `keys in ${this.latest.app}`, value: r.text });
          return NO_TERMINAL;
        }
        const spec = parseShortcut(r.text);
        if (!spec) throw new Error(`I don't know the key "${r.text}"`);
        const keyRisk = riskOf({ kind: 'shortcut', keys: r.text }, this.latest && this.latest.focused);
        if (keyRisk && !(await this.confirm(this.s(/^send /.test(keyRisk) ? `Ready to ${keyRisk}. Send it{sir}?` : `That would press ${spokenKeys(r.text)}. Shall I go ahead{sir}?`)))) {
          this.stop('declined');
          this.check();
        }
        await this.doAct(() => this.act.keys(spec));
        this.record({ kind: 'keys', detail: r.text });
        await this.wait(SETTLE_MS);
        return `Done: pressed ${r.text}.`;
      }
      case 'open_url': {
        const url = cleanUrl(r.text);
        if (!url) throw new Error(`"${r.text}" isn't a web address`);
        await this.doAct(() => this.act.openUrl(url));
        this.record({ kind: 'go', detail: `opened ${url}` });
        await this.wait(2500);
        return `Done: opened ${url}.`;
      }
      case 'open_app': {
        let ok = false;
        await this.doAct(async () => {
          ok = await this.act.openApp(r.text || '');
        });
        this.record({ kind: 'go', detail: ok ? `opened ${r.text}` : `couldn't find ${r.text}` });
        if (!ok) throw new Error(`there's no app called "${r.text}" in Applications`);
        await this.wait(2000);
        return `Done: opened ${r.text}.`;
      }
      case 'open_file': {
        let name = null;
        await this.doAct(async () => {
          name = this.act.openFile ? await this.act.openFile(r.text || '') : null;
        });
        this.record({ kind: 'go', detail: name ? `opened file ${name}` : `no file for "${r.text}"` });
        if (!name) throw new Error(`no file matching "${r.text}" in the home folder`);
        await this.wait(2000);
        return `Done: opened the file ${name}.`;
      }
      case 'switch_to': {
        let which = null;
        await this.doAct(async () => {
          which = this.act.switchTo ? await this.act.switchTo(r.text || '') : null;
        });
        this.record({ kind: 'go', detail: which ? `switched to ${which}` : `nothing open like "${r.text}"` });
        if (!which) throw new Error(`nothing open matches "${r.text}"`);
        await this.wait(SETTLE_MS);
        return `Done: brought ${which} to the front.`;
      }
      case 'read_file': {
        const got = this.act.readFile ? await this.act.readFile(r.text || '') : { ok: false, why: 'unavailable' };
        this.record({ kind: 'read', detail: got.ok ? got.path : `couldn't read "${r.text}" (${got.why})` });
        if (!got.ok) throw new Error(got.why === 'secret' ? `"${r.text}" looks like it holds secrets, so I won't read it` : `couldn't read "${r.text}" (${got.why})`);
        return `${got.folder ? 'Folder' : 'File'} ${got.path}${got.folder ? ' contains' : ' says'}:\n${got.text}`;
      }
      case 'run_command': {
        // Only a command the project documents, in that project's folder, after a yes (src/runproject.js).
        const command = String(r.text || '').trim();
        const folder = String(r.folder || '').trim();
        const v = commandVerdict(command, folder);
        if (!v.ok) {
          this.record({ kind: 'refused', detail: `run in ${folder}`, value: `${command} (${v.why})` });
          return `Refused to run "${command}" in ${folder}: ${v.why}.`;
        }
        if (!this.act.runCommand) throw new Error("I can't run commands here");
        // Know what's already running from this project before starting
        // anything: starting a second copy just fails on a busy port. Asked for
        // again after seeing this, it runs (tests, a build: not a restart).
        const key = `${v.dir}\n${command}`;
        const running = this.act.serversIn && !this.ranAnyway.has(key) ? await this.act.serversIn(v.dir) : [];
        if (running.length) {
          this.ranAnyway.add(key);
          this.record({ kind: 'already-running', detail: v.dir, value: running.map((x) => `${x.command}:${x.port}`).join(', ') });
          return `Not run yet. Already running from this project: ${running.map((x) => `${x.command} on http://localhost:${x.port} (in ${x.folder})`).join('; ')}. If "${command}" would start it again, use that instead. If it does something else, give the same run_command again and it will run.`;
        }
        const where = folder.replace(/^~\//, '');
        if (!(await this.confirm(this.s(`I'll run "${command}" in ${where}. Go ahead{sir}?`)))) {
          return 'The user said no to running that. Finish (status done) with the command for them to run themselves, in one sentence.';
        }
        let got = null;
        await this.doAct(async () => {
          got = await this.act.runCommand({ dir: v.dir, command });
        });
        this.record({ kind: 'run', detail: `${v.dir}: ${command}`, value: got && got.output ? got.output.slice(-400) : '' });
        if (!got || !got.ok) throw new Error(got && got.why ? got.why : `couldn't run "${command}"`);
        const servers = (got.servers || []).map((x) => `${x.command} on http://localhost:${x.port} (started in ${x.folder})`);
        return `Ran "${command}" in ${v.dir}, in a Terminal window (${got.finished ? `it has finished, exit code ${got.code}` : 'still running'}).${got.urls.length ? ` Web addresses in its output: ${got.urls.join(', ')}.` : ''}${servers.length ? ` Local servers running now: ${servers.join('; ')}.` : ''} Output so far:\n${got.output || '(nothing yet)'}`;
      }
      case 'wait':
        await this.wait(2000);
        return 'Waited a moment.';
      default:
        throw new Error('that step had no action');
    }
  }
}

module.exports = { JarvisRun, JarvisFreestyle, planRun, normalizePlan, riskOf, isSensitiveField, isSearchLikeField, isYes, sameValue, describeSkillForJarvis, spokenKeys };
