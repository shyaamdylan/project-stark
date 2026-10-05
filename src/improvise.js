// Best-effort help for tasks nobody has taught yet.
//
// A learned skill is always preferred: it carries an expert's steps, reasons
// and guardrails. For everything else (opening an app, searching a site,
// changing a common setting) the assistant can still have a go using general
// knowledge and what's on screen, one step at a time.
//
// It has to be honest about it. Each turn Claude either gives the next step,
// says the goal is reached, asks the user for something it needs, or says
// "needs_teaching": it isn't confident it can do this properly (a specialised
// or company-specific process, a judgment call, something hard to undo that it
// would be guessing at, or it has tried and it isn't working). That can happen
// at the start or halfway through.
//
// Two modes:
//   guide  Friday points at each thing; the user does it.
//   do     Jarvis does it himself (src/jarvis.js runs the actions, with the
//          same safety checks as a learned skill).

const { Anthropic } = require('@anthropic-ai/sdk');
const { describeScreen } = require('./guide');

const MODEL = 'claude-opus-5-5';
const MAX_TURNS = 20;
const KEEP_SCREENS = 2; // older screens are dropped from the conversation to keep it quick

const HONESTY = `You haven't been taught this task by an expert, so you rely on general knowledge of macOS, common apps and websites, and what's on screen. Be genuinely helpful, and honest.

Use status "needs_teaching" when you are not confident you can do it properly, at the start or at any point along the way:
- a specialised or organisation-specific process (internal tools, company rules, approvals, codes, who to send things to),
- a judgment call you can't check,
- you'd be guessing at anything hard to undo (sending, paying, deleting, submitting),
- you've tried twice and it isn't working, or the screen isn't what you expected.
Then say, in one or two short sentences, which part you don't know and that someone who knows it should teach it. Don't apologise at length.

Use status "need_info" when you need something only the user knows (which file, what to call it, what to type); put the question in say. Never ask for passwords, card numbers or codes.
Use status "done" only when the screen shows the goal is reached.`;

const SCREEN_FORMAT = `Each turn you get what happened since your last step, then a numbered list of what's visible on screen, from macOS accessibility. Every line looks like:
  id | role | "label" | app | x,y
The list is front window first. Items under an open menu appear only while that menu is open.`;

function guideSystem() {
  return `You are Friday, the voice of a friendly on-screen helper on a Mac. The user asked how to do something you haven't been taught. You walk them through it one step at a time by pointing at things; they do each step themselves.

${HONESTY}

${SCREEN_FORMAT}

Reply with status "step" and the single next thing to do: target_id is the element to point at (from the current list, or null if it isn't on screen; then say how to get to it), and say is one short, friendly sentence (under 25 words), spoken aloud, so no markdown, ids or coordinates. action.kind is "point" (or "none" with no target). On your first reply, summary is one short sentence on what you'll help them do; otherwise "".`;
}

function doSystem(address) {
  const addr = String(address || '').trim();
  return `You are J.A.R.V.I.S., the calm, capable AI butler from Iron Man: polite, unflappable, concise, with a dry British wit. ${addr ? `You address the user as "${addr}" now and then.` : 'You never use a form of address like sir or madam.'} The user asked you to do something on their Mac that you haven't been taught, and you're doing it for them, one action at a time.

${HONESTY}

${SCREEN_FORMAT}

Reply with status "step" and the single next action:
- "click": target_id of the element to click.
- "type": target_id of the field to type into (it's clicked and its text replaced), text to type. Add a separate "keys" step for Enter if needed. Never type passwords, card numbers or codes: ask the user to enter those themselves with need_info.
- "keys": text is the shortcut with ⌘ ⌃ ⌥ ⇧ then the key name, e.g. "⌘S", "⇧⌘N", "Enter", "Escape", "Tab", "ArrowDown".
- "open_url": text is a web address. Prefer this to clicking through menus when you know the page.
- "open_app": text is the app's name as it appears in Applications.
- "open_file": text is a short description of a file to find and open ("Q3 budget spreadsheet").
- "switch_to": text names an already-open window or browser tab to bring to the front ("budget spreadsheet", "YouTube").
- "read_file": text is a path in the home folder ("~/Documents/my-app/README.md") or a description ("the my-app readme"). You get its text (or a folder's list of files) next turn. Use it to learn how something works instead of reading it off the screen.
Prefer these direct actions (open_file, read_file, open_url, open_app, switch_to) over clicking through menus whenever they do the job: they're faster and more reliable.
- "run_command": runs one command in a visible Terminal window: text is the command, folder is the project folder ("~/Documents/my-app"). The user is asked first automatically. Next turn you get its output so far and any local web addresses it printed. Use it when asked to run, start, set up or test a software project: read its README (and package.json) with read_file first, then run the command it documents, exactly as written there; one command per step. You may put an environment variable the README mentions in front ("PORT=3100 npm run dev"), e.g. to pick a free port. Commands the project doesn't document, deleting, sudo and system changes are refused.
To start a project, try its run command first; only run install or setup steps if that fails because something isn't installed (or the folder list shows it was never set up, e.g. no node_modules or .venv where the README expects one).
If you're told servers from that project are already running, it's probably already up: open_url its address rather than starting it again (only repeat the run_command if the command does something else, like tests). Use only addresses you've been given; never guess a port.
After starting a web app, open_url the local address from its output, then finish with done ("My-app is running at localhost:3100."). If it fails, read the error in the output and fix the cause with another documented command (a setup step first), or say in one sentence what the user must do.
You never type or press keys in a terminal app: use run_command.
- "wait": give a page or app a moment to load.

Talk as little as possible: the user wants it done, not described.
- say: at most 6 words on the step ("Reading the README."). It's shown on screen, not spoken.
- summary (first reply only, otherwise ""): at most 10 words, spoken ("Opening the README, sir.").
- With "done", say is the result the user needs, as short as it can be ("Done: it's at localhost:3100.").
- With "needs_teaching" or "need_info", say is one short sentence.
Act, don't ask: if the request names something (a project, a file), find it with read_file or open_file rather than asking where it is. If the user left a choice to you ("a nice song", "any good recipe"), make a sensible choice yourself and say what you chose, rather than asking.`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['step', 'done', 'need_info', 'needs_teaching'] },
    say: { type: 'string' },
    summary: { type: 'string' },
    action: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['point', 'click', 'type', 'keys', 'open_url', 'open_app', 'open_file', 'switch_to', 'read_file', 'run_command', 'wait', 'none'] },
        target_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        folder: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['kind', 'target_id', 'text', 'folder'],
      additionalProperties: false,
    },
  },
  required: ['status', 'say', 'summary', 'action'],
  additionalProperties: false,
};

class Improviser {
  // mode: 'guide' (Friday points) or 'do' (Jarvis acts)
  constructor(apiKey, { mode = 'guide', address = '', client = null } = {}) {
    this.client = client || new Anthropic({ apiKey });
    this.mode = mode;
    this.system = mode === 'do' ? doSystem(address) : guideSystem();
    this.turns = []; // { note, screen, reply }
    this.chosen = [];
    this.inFlight = false;
  }

  // Older screens are replaced by a placeholder and long older notes (a file's
  // text) are trimmed: the latest ones are what matter.
  messages() {
    const out = [];
    this.turns.forEach((t, i) => {
      const recent = i >= this.turns.length - KEEP_SCREENS;
      const note = recent || t.note.length <= 2500 ? t.note : `${t.note.slice(0, 2500)}\n…(trimmed)`;
      out.push({ role: 'user', content: `${note}\n\n${recent ? `On screen now:\n${t.screen}` : '(screen from earlier omitted)'}` });
      if (t.reply) out.push({ role: 'assistant', content: t.reply });
    });
    return out;
  }

  // One turn: what happened, then the current screen -> the next step.
  // Returns { status, say, summary, kind, target, text }.
  async next(note, scan) {
    if (this.inFlight) throw Object.assign(new Error('A step is already in progress.'), { busy: true });
    if (this.turns.length >= MAX_TURNS) {
      return { status: 'needs_teaching', say: "That's taking far more steps than it should, so I'll stop here. This one is worth teaching properly.", summary: '', kind: 'none', target: null, text: null };
    }
    this.inFlight = true;
    try {
      const screen = describeScreen(scan && scan.elements ? scan.elements : []);
      this.chosen = screen.chosen;
      const turn = { note: `${note}${scan && scan.app ? `\nFront app: ${scan.app}${scan.window ? ` — "${scan.window}"` : ''}` : ''}`, screen: screen.text || '(nothing readable on screen)', reply: null };
      this.turns.push(turn);
      let response;
      try {
        response = await this.client.beta.messages.create({
          model: MODEL,
          max_tokens: 4000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          // A live UI: keep each step snappy.
          output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
          system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
          messages: this.messages(),
        });
      } catch (err) {
        this.turns.pop();
        throw err;
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      turn.reply = text || '{}';
      if (response.stop_reason === 'refusal') return { status: 'needs_teaching', say: "That's not something I can help with.", summary: '', kind: 'none', target: null, text: null };
      let r;
      try {
        r = JSON.parse(text);
      } catch {
        return { status: 'needs_teaching', say: 'I lost my train of thought there. This one is worth teaching properly.', summary: '', kind: 'none', target: null, text: null };
      }
      const a = r.action || {};
      const target = Number.isInteger(a.target_id) ? this.chosen[a.target_id] || null : null;
      return { status: r.status, say: r.say || '', summary: r.summary || '', kind: a.kind || 'none', target, text: a.text == null ? null : String(a.text), folder: a.folder == null ? null : String(a.folder) };
    } finally {
      this.inFlight = false;
    }
  }
}

// Friday walking someone through a task she wasn't taught: point at the next
// thing, wait until they've done it (a click, some typing, or the screen
// changing), then look again and work out the next step.
//
// deps:
//   goal            what the user asked for
//   brain           an Improviser in 'guide' mode
//   scan()          front-window scan
//   fingerprint()   cheap summary of the screen; a change means they did something
//   emit(step)      { status: 'step' | 'done' | 'stuck', say, target, stepNumber }
//   ask(text)       a question for the user -> their answer ('' if skipped)
//   thinking()      show that she's working out the next step
class ImprovisedWalkthrough {
  constructor({ goal, brain, scan, fingerprint, emit, ask, thinking = () => {}, pollMs = 500, idleMs = 1200, giveUpMs = 180000 }) {
    Object.assign(this, { goal, brain, scanFn: scan, fingerprint, emit, ask, thinking, pollMs, idleMs, giveUpMs });
    this.running = false;
    this.inputAt = 0;
    this.skipped = false;
    this.steps = 0;
  }

  onInput() {
    this.inputAt = Date.now();
  }

  skip() {
    this.skipped = true;
  }

  stop() {
    this.running = false;
  }

  async start() {
    this.running = true;
    let note = `The user asked: "${this.goal}"`;
    try {
      while (this.running) {
        this.thinking();
        const s = await this.scanFn();
        if (!this.running) return;
        const r = await this.brain.next(note, s && !s.error ? s : { elements: [] });
        if (!this.running) return;
        const first = this.steps === 0;

        if (r.status === 'done') return this.end('done', r.say || "That's it, you're there.");
        if (r.status === 'needs_teaching') {
          const lead = first ? "I haven't been taught that one. " : "I'm not sure about the next part. ";
          return this.end('stuck', `${lead}${r.say} If you know how, say "let me show you" and I'll learn it.`);
        }
        if (r.status === 'need_info') {
          const answer = await this.ask(r.say);
          if (!this.running) return;
          if (!answer) return this.end('stuck', "Okay, I'll leave it there.");
          note = `The user answered: "${answer}"`;
          continue;
        }

        this.steps++;
        const intro = first ? "I haven't been taught this, but let's give it a go. " : '';
        this.emit({ status: 'step', say: `${intro}${r.say}`, target: r.target, stepNumber: this.steps });
        const what = await this.waitForUser();
        if (!this.running) return;
        if (what === 'timeout') return this.end('stuck', "I'll leave you to it. Ask again if you need me.");
        note = what === 'next' ? 'The user pressed Next: they did that step, or want to move on.' : 'The user did something. Check what changed and give the next step.';
      }
    } catch (err) {
      console.error('[improvise]', err.status || '', err.message);
      if (this.running) this.end('stuck', "I couldn't work out the next step just now. Try asking again in a moment.");
    }
  }

  end(status, say) {
    this.running = false;
    this.emit({ status, say, target: null, stepNumber: this.steps });
  }

  // Resolves 'input' (they clicked or typed, then paused), 'changed' (the
  // screen changed and settled), 'next' (they pressed Next) or 'timeout'.
  async waitForUser() {
    const shownAt = Date.now();
    this.skipped = false;
    let base = null;
    let lastPrint = null;
    let changedAt = 0;
    try {
      base = await this.fingerprint();
    } catch {}
    lastPrint = base;
    while (this.running) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      const now = Date.now();
      if (this.skipped) return 'next';
      if (this.inputAt > shownAt && now - this.inputAt >= this.idleMs) return 'input';
      let print = null;
      try {
        print = await this.fingerprint();
      } catch {}
      if (print !== lastPrint) {
        lastPrint = print;
        changedAt = now;
      }
      if (changedAt && print !== base && now - changedAt >= this.idleMs && now - this.inputAt >= this.idleMs) return 'changed';
      if (now - shownAt > this.giveUpMs) return 'timeout';
    }
    return 'stopped';
  }
}

module.exports = { Improviser, ImprovisedWalkthrough, MAX_TURNS };
