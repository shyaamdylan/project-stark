// Friday as a teacher, not a scripted tutorial.
//
// The learned Work Map is the lesson plan, and the replay (src/replay.js) still
// moves you through it instantly while you're on track: no Claude call when
// you just do the next thing. A tutor turn (Claude) happens only when there's
// something worth thinking about:
//   said       you asked or said something ("why are we doing this?")
//   off-path   you clicked something other than what was asked
//   lost       what's needed isn't on screen (you're somewhere else)
//   idle       nothing's happened for a while after an instruction
// Each turn sees the plan, where you are in it, what you've done since it last
// spoke (src/observe.js: clicks, typing, windows, focus; no screenshots) and
// what's on screen, then decides: answer, correct, accept another route, skip
// steps you've chosen not to do, check in, or carry on with the plan.

const { Anthropic } = require('@anthropic-ai/sdk');
const { Replay } = require('./replay');
const { describeScreen, describeSkill } = require('./guide');
const { ScreenObserver } = require('./observe');
const { imageBlock, boxToScreen, screenshotNote, POINT_SCHEMA } = require('./vision');

const MODEL = 'claude-opus-5-5';
const MAX_TURNS = 40;
const KEEP_SCREENS = 2;

const SYSTEM = `You are Friday, a warm, sharp teacher who lives as a small glowing orb on someone's Mac. You're teaching them a task an expert showed you (the lesson plan below). This is a real lesson, a two-way conversation, not a click-through tutorial.

You see their screen two ways: a screenshot of their screen with which window is where (go by it; they may mean a window that isn't in front), and the app's accessibility list, numbered lines "id | role | "label" | app | x,y", which gives exact positions for the controls it describes. You also get a log of what they've done since you last spoke (clicks, typing, windows, where the keyboard is) and, if they spoke, what they said.

How to teach:
- Keep the goal in mind and the plan as your structure, but adapt to what they actually do.
- They did something that will lead them astray: say plainly what happened and how to fix it ("That opened Preferences instead. Close it, then click Export."). Mention undo (Command Z) when it helps.
- They got there another way: that's fine. Accept it and carry on from where they are.
- They choose not to do an optional part ("I don't want to use that mode"): respect it. Put the steps that only apply to it in skip_steps, and never give instructions that assume they're in it.
- They ask a question (why, how long, what does this do): answer it directly and briefly using the plan, the expert's reasons and the steps left, then steer back to the goal.
- They wander off topic a little: go with it for a sentence, then bring them back.
- They seem stuck or unsure ("I'm not sure how", "where is it?"): show them. Point at exactly the thing to use with target_id; if it's inside a menu that isn't open, point at the menu first and say so.
- They've gone quiet after an instruction: check in gently, once ("Still with me? It's the blue Export button, top right."), or ask whether they'd rather skip that bit.
- Vague words in what they say ("this", "it", "that one", "here") mean what's on their screen: the front window, its file, the selected text, the field they're in. Go with the most sensible reading.
- Never invent steps for the task itself beyond the plan; general help (where something is, how to undo) is fine.

Reply:
- say: what you say out loud, one or two short, natural sentences, no markdown, ids or coordinates. Empty only if there's genuinely nothing worth saying.
- target_id: an element from the current list to point at (exact), or null.
- point: when what you want to point at isn't in the list (part of a picture, something the app doesn't describe) but you can see it in the screenshot, its bounding box in the screenshot's own pixels with a short label; otherwise null. Use at most one of target_id and point.
- step_number: the plan step they should be on now (1-based).
- then: "resume" when they're back on the plan at step_number and the lesson should carry on with it (your say replaces its usual line, so include the instruction); "wait" when you've asked something or they need a moment, and you'll listen.
- skip_steps: plan steps to leave out from now on (often []).
- status: "continue"; "done" when the goal is reached; "stop" if they want to stop.`;

const SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    target_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    point: POINT_SCHEMA,
    step_number: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    then: { type: 'string', enum: ['resume', 'wait'] },
    skip_steps: { type: 'array', items: { type: 'integer' } },
    status: { type: 'string', enum: ['continue', 'done', 'stop'] },
  },
  required: ['say', 'target_id', 'point', 'step_number', 'then', 'skip_steps', 'status'],
  additionalProperties: false,
};

// Checking a decision the learner filled in, at a judgment call or a step with
// guardrails, before the lesson moves on (and before they save it).
const JUDGE_SYSTEM = `You are Friday, a warm, sharp teacher on someone's Mac. You're teaching them a task an expert showed you. They've just filled in a decision at a step where the expert used judgment or where there are guardrails. Decide whether what they entered is right for the case in front of them now, which may differ from the expert's own case.

You get the step (what to do, the decision the expert made in their case, the expert's reason in their own words, any rule and guardrails), what the learner entered, and their screen: a screenshot and the accessibility list. Read the case's details off the screen (amounts, item types, names, dates, flags).

- ok true when the value fits the expert's reasoning and guardrails for this case, or when the screen doesn't show enough to say it's wrong. Don't nag about formatting or anything the expert's reasoning doesn't cover.
- ok false only when it clearly goes against the expert's reason, rule or a guardrail for this case. Then say, out loud, in two or three short sentences: stop them before they move on or save ("Hold on, the expert would stop here."), explain why using the expert's own reasoning applied to what's on screen now, and ask them to change it. Don't lecture.
- target_id: the field or thing to look at, from the list, or null.`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    say: { type: 'string' },
    target_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  },
  required: ['ok', 'say', 'target_id'],
  additionalProperties: false,
};

const TRIGGERS = {
  said: (d) => `They said: "${d}"`,
  'off-path': (d) => `They did something other than the current instruction (${d}).`,
  lost: (d) => `${d} They may be somewhere else.`,
  idle: (d) => `Nothing has happened for ${d} seconds since your last instruction.`,
};

class Tutor {
  constructor(apiKey, skill, { client = null } = {}) {
    this.client = client || new Anthropic({ apiKey });
    this.skill = skill;
    this.turns = []; // { text, screen, reply }
    this.chosen = [];
    this.notes = []; // things that happened outside a turn (a decision she stopped), told on the next one
  }

  // Is the decision they filled in right for this case? ctx: { stepNumber,
  // label, value, expertValue, scan, image, where }. Returns { ok, say, target }.
  async judge(ctx) {
    const step = this.skill.map.steps[ctx.stepNumber - 1];
    if (!step) return { ok: true, say: '', target: null };
    const screen = describeScreen((ctx.scan && ctx.scan.elements) || []);
    const lines = [
      `Task: ${this.skill.map.title}${this.skill.map.summary ? ` (${this.skill.map.summary})` : ''}`,
      `Step ${ctx.stepNumber}: ${step.title}`,
      `Do: ${step.action}`,
      step.decision ? `The expert's decision in their own case: ${step.decision}` : '',
      ctx.expertValue != null && ctx.expertValue !== '' ? `The expert entered "${ctx.expertValue}" in "${ctx.label}" for their case.` : '',
      step.reason ? `The expert's reason, in their words: "${step.reason}"` : '',
      step.rule ? `Rule: ${step.rule}` : '',
      ...(step.guardrails || []).map((g) => `Guardrail (${g.kind.replace(/_/g, ' ')}): ${g.text}`),
      `The learner entered "${ctx.value}" in "${ctx.label}".`,
      `Where they are: ${ctx.where || 'unknown'}`,
      `On screen now:\n${screen.text || '(nothing readable)'}`,
    ].filter(Boolean);
    const text = lines.join('\n');
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 1500,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
      system: [{ type: 'text', text: JUDGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: ctx.image ? [imageBlock(ctx.image), { type: 'text', text: `${screenshotNote(ctx.image)}\n${text}` }] : text }],
    });
    let r;
    try {
      r = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    } catch {
      return { ok: true, say: '', target: null };
    }
    const ok = r.ok !== false || !String(r.say || '').trim();
    if (!ok) this.notes.push(`At step ${ctx.stepNumber} they entered "${ctx.value}" in "${ctx.label}", and you stopped them: "${r.say}"`);
    return { ok, say: ok ? '' : r.say, target: Number.isInteger(r.target_id) ? screen.chosen[r.target_id] || null : null };
  }

  messages() {
    const out = [];
    const last = this.turns.length - 1;
    this.turns.forEach((t, i) => {
      const recent = i >= this.turns.length - KEEP_SCREENS;
      const text = `${t.text}\n\n${recent ? `On screen now:\n${t.screen}` : '(screen from earlier omitted)'}`;
      // Only the latest screenshot goes: older ones cost tokens and are out of date.
      if (i === last && t.image) out.push({ role: 'user', content: [imageBlock(t.image), { type: 'text', text: `${screenshotNote(t.image)}\n${text}` }] });
      else out.push({ role: 'user', content: text });
      if (t.reply) out.push({ role: 'assistant', content: t.reply });
    });
    return out;
  }

  // One turn. ctx: { trigger, detail, did: [lines], where, lesson: { stepNumber, totalSteps, line, skipped }, scan }
  async turn(ctx) {
    if (this.turns.length >= MAX_TURNS) return { say: "Let's pause the lesson here. Ask me again whenever you like.", target: null, stepNumber: null, then: 'wait', skipSteps: [], status: 'stop' };
    const screen = describeScreen((ctx.scan && ctx.scan.elements) || []);
    this.chosen = screen.chosen;
    const l = ctx.lesson || {};
    const parts = [];
    if (!this.turns.length) parts.push(`Lesson plan:\n${describeSkill(this.skill)}`);
    // What happened between turns (a decision she stopped them on), so "why?" makes sense.
    if (this.notes.length) parts.push(`Since your last turn:\n${this.notes.splice(0).map((n) => `- ${n}`).join('\n')}`);
    parts.push(
      `Where the lesson is: step ${l.stepNumber || '?'} of ${l.totalSteps || '?'}. Current instruction: "${l.line || ''}"${l.skipped && l.skipped.length ? `. Steps they've chosen to skip: ${l.skipped.join(', ')}` : ''}.`,
      `What they've done since you last spoke:\n${ctx.did && ctx.did.length ? ctx.did.map((x) => `- ${x}`).join('\n') : '- nothing'}`,
      `Where they are: ${ctx.where || 'unknown'}`,
      (TRIGGERS[ctx.trigger] || ((d) => d))(ctx.detail)
    );
    const turn = { text: parts.join('\n\n'), screen: screen.text || '(nothing readable on screen)', image: ctx.image || null, reply: null };
    this.turns.push(turn);
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: 3000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: this.messages(),
      });
    } catch (err) {
      this.turns.pop();
      throw err;
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    turn.reply = text || '{}';
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      return { say: '', target: null, stepNumber: null, then: 'wait', skipSteps: [], status: 'continue' };
    }
    const exact = Number.isInteger(r.target_id) ? this.chosen[r.target_id] || null : null;
    return {
      say: r.say || '',
      // Exact from the list, or the spot on the screenshot.
      target: exact || (r.point && ctx.image ? boxToScreen(r.point, ctx.image, ctx.image.frame) : null),
      stepNumber: Number.isInteger(r.step_number) ? r.step_number : null,
      then: r.then === 'resume' ? 'resume' : 'wait',
      skipSteps: Array.isArray(r.skip_steps) ? r.skip_steps.filter(Number.isInteger) : [],
      status: ['done', 'stop'].includes(r.status) ? r.status : 'continue',
    };
  }
}

// The lesson: the replay for speed, the observer for awareness, the tutor for judgment.
class Lesson {
  // deps:
  //   skill, plan        as for Replay
  //   scan()             front-window scan
  //   emit(step)         { status, say, note, target, stepNumber, totalSteps, quietMove }
  //   thinking()         show that she's thinking
  //   tutor              a Tutor (or a fake in tests)
  //   idleMs             quiet time after an instruction before checking in
  //   offPathDelayMs     how long to let a stray click play out before commenting
  //   snap(scan)         a screenshot of the front window for a tutor turn, or null
  constructor({ skill, plan, scan, emit, thinking = () => {}, tutor, snap = async () => null, idleMs = 30000, offPathDelayMs = 1500, now = () => Date.now() }) {
    this.snap = snap;
    this.skill = skill;
    this.emitOut = emit;
    this.thinking = thinking;
    this.tutor = tutor;
    this.idleMs = idleMs;
    this.offPathDelayMs = offPathDelayMs;
    this.now = now;
    this.observer = new ScreenObserver({ now });
    this.running = false;
    this.busy = false;
    this.pending = null; // { trigger, detail } waiting for the current turn to finish
    this.timer = null;
    this.idleTimer = null;
    this.lastSpokeAt = now(); // last instruction or tutor reply
    this.lastAskedAt = 0;
    this.nudges = 0;
    this.replay = new Replay({
      skill,
      plan,
      scan: async () => {
        const s = await scan();
        if (s && !s.error) this.observer.onScan(s);
        return s;
      },
      emit: (step) => this.fromReplay(step),
      thinking,
    });
    this.replay.onOffPath = (why) => this.schedule('off-path', why, this.offPathDelayMs);
    if (tutor && typeof tutor.judge === 'function') this.replay.judge = (a, field, s) => this.judgeStep(a, field, s);
    this.replay.onLost = (why) => this.schedule('lost', why, 0);
  }

  get total() {
    return this.replay.total;
  }

  // A decision they filled in, checked against the expert's reasoning for the
  // case on their screen. Counts as her speaking, so no idle nudge right after.
  async judgeStep(a, field, s) {
    const image = await this.snap(s).catch(() => null);
    const r = await this.tutor.judge({
      stepNumber: a.stepIndex + 1,
      label: field.label || a.label,
      value: field.value == null ? '' : String(field.value),
      expertValue: a.value,
      scan: s,
      image,
      where: this.observer.where(),
    });
    console.log(`[lesson] step ${a.stepIndex + 1}: "${field.value}" in "${field.label || a.label}" → ${r.ok ? 'fine' : 'stopped them'}`);
    if (!r.ok) {
      this.lastSpokeAt = this.now();
      this.nudges = 0;
    }
    return { ok: r.ok, say: r.say };
  }

  lines() {
    return this.replay.lines();
  }

  async start() {
    this.running = true;
    this.idleTimer = setInterval(() => this.checkIdle(), 2000);
    await this.replay.start();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.idleTimer);
    this.replay.stop();
  }

  onMouseDown(x, y) {
    if (!this.running) return;
    this.observer.onClick(x, y);
    this.replay.onMouseDown(x, y);
  }

  onKey(keys) {
    if (!this.running) return;
    this.observer.onKey(keys);
    this.replay.onKey(keys);
  }

  skip() {
    this.replay.skip();
  }

  // Anything they say or type during the lesson goes straight to the tutor.
  onUserSays(text) {
    if (!this.running || !String(text || '').trim()) return;
    clearTimeout(this.timer);
    this.ask('said', String(text).trim());
  }

  fromReplay(step) {
    if (!this.running) return;
    if (step.status === 'step' && step.say) {
      this.lastSpokeAt = this.now();
      this.nudges = 0;
    }
    if (step.status !== 'step') this.running = false;
    this.emitOut(step);
    if (!this.running) this.stop();
  }

  // Let a stray click play out (they might be on their way) before commenting.
  schedule(trigger, detail, delay) {
    if (!this.running) return;
    clearTimeout(this.timer);
    const at = this.replay.index;
    this.timer = setTimeout(() => {
      if (this.running && this.replay.index === at) this.ask(trigger, detail);
    }, delay);
  }

  checkIdle() {
    if (!this.running || this.busy) return;
    const quietSince = Math.max(this.lastSpokeAt, this.observer.lastInputAt, this.replay.progressAt || 0);
    const wait = this.idleMs * (this.nudges + 1);
    if (this.nudges < 2 && this.now() - quietSince > wait) {
      this.nudges++;
      this.ask('idle', Math.round((this.now() - quietSince) / 1000));
    }
  }

  async ask(trigger, detail) {
    if (!this.running) return;
    if (this.busy) {
      // What they say always wins over a scheduled nudge.
      if (!this.pending || trigger === 'said') this.pending = { trigger, detail };
      return;
    }
    this.busy = true;
    this.thinking();
    const since = this.lastAskedAt || this.lastSpokeAt - 1;
    this.lastAskedAt = this.now();
    try {
      const image = await this.snap(this.replay.latest).catch(() => null);
      const r = await this.tutor.turn({
        trigger,
        detail,
        did: this.observer.since(since),
        where: this.observer.where(),
        lesson: this.replay.where() || {},
        scan: this.replay.latest,
        image,
      });
      if (this.running) await this.apply(r);
    } catch (err) {
      console.error('[tutor]', err.status || '', err.message);
      if (this.running && trigger === 'said') this.emitOut({ status: 'step', say: "Sorry, I didn't catch that properly. Could you say it again?", target: null, stepNumber: (this.replay.where() || {}).stepNumber, totalSteps: this.total, chat: true });
    } finally {
      this.busy = false;
    }
    if (this.pending && this.running) {
      const p = this.pending;
      this.pending = null;
      this.ask(p.trigger, p.detail);
    }
  }

  async apply(r) {
    this.lastSpokeAt = this.now();
    if (r.skipSteps.length) this.replay.skipSteps(r.skipSteps);
    if (r.status === 'done' || r.status === 'stop') {
      this.running = false;
      this.emitOut({ status: r.status === 'done' ? 'done' : 'stuck', say: r.say || (r.status === 'done' ? "That's it, you've done it." : "Okay, we'll stop there."), target: null, stepNumber: (this.replay.where() || {}).stepNumber, totalSteps: this.total });
      this.stop();
      return;
    }
    // Back on the plan: the replay carries on from that step, with her words.
    if (r.then === 'resume' && r.stepNumber) {
      // If she pointed somewhere specific, that wins over the step's usual target.
      if (await this.replay.jumpToStep(r.stepNumber, { say: r.say || null, target: r.target })) return;
    }
    // An answer, a correction or a check-in: say it, point if it helps, and keep listening.
    this.emitOut({ status: 'step', say: r.say, note: '', target: r.target, stepNumber: r.stepNumber || (this.replay.where() || {}).stepNumber, totalSteps: this.total, chat: true, quietMove: !r.say && Boolean(r.target) });
  }
}

module.exports = { Tutor, Lesson, SYSTEM };
