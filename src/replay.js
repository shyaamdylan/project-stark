// Plays back a learned skill in real time, without waiting on Claude.
//
// A Work Map records what the expert actually did at each step ("clicked File",
// "chose New Folder", "changed Cost center"). We turn that into a list of
// actions and follow along live: find the same thing on the user's screen by
// name, point at it, and the moment they do it (clicked inside it, finished
// typing in it, pressed the shortcut) move straight on to the next one.
//
// Claude is only asked when we can't find the next thing on screen (they went
// somewhere else, or the app looks different); see `recover`.
//
// A "go" action (a step about reaching a website, app or screen) is done the
// moment the user is there, however they got there, or as soon as the next
// thing to click shows up. If they're already there it's skipped.

const { findBest, normalize } = require('./matcher');
const { follow } = require('./track');
const { optionOf, branchOf, progress } = require('./forks');

const RETRY_MS = 2500; // how long to keep looking for a target before asking Claude
const SETTLE_MS = 900; // a field must stop changing this long to count as filled in
const MAX_RECOVERIES = 2; // Claude calls per step before we just wait quietly (Next still works)
const LOOK_AHEAD = 4; // how many actions ahead to watch for, to notice the user is already past this one
const MOVED_PX = 4; // the thing being pointed at moved (scrolled, window dragged): follow it

// Clicks on rows, cells and text are about the specific record (this invoice,
// that file), so the user's equivalent won't have the same label. Any click counts.
const RECORD_ROLES = new Set(['AXRow', 'AXCell', 'AXStaticText', 'AXImage']);

const KEY_WORDS = { '⌘': 'Command ', '⌃': 'Control ', '⌥': 'Option ', '⇧': 'Shift ' };
const spokenKeys = (keys) => keys.replace(/[⌘⌃⌥⇧]/g, (k) => KEY_WORDS[k]).trim();

// The actions to follow. With a replay plan (Claude's cleaned-up version of the
// recording, see planReplay) we use that; otherwise every action the expert took.
function buildActions(skill, plan) {
  if (plan && plan.actions && plan.actions.length) {
    const events = new Map((skill.session.events || []).map((e) => [e.id, e]));
    let lastStep = -1;
    return plan.actions.map((p) => {
      const e = p.event_id != null ? events.get(p.event_id) : null;
      const stepIndex = Math.max(0, Math.min(skill.map.steps.length - 1, p.step_number - 1));
      const first = stepIndex !== lastStep;
      lastStep = stepIndex;
      const step = skill.map.steps[stepIndex];
      if (p.kind === 'go' || (step.kind === 'go' && !e)) {
        return { stepIndex, first, kind: 'go', role: null, label: '', destination: step.destination || null, say: p.say };
      }
      const kind = p.kind === 'choose' ? 'choose' : p.kind === 'look' || !e ? 'look' : e.type === 'click' && RECORD_ROLES.has(e.role) ? 'choose' : p.kind;
      return { stepIndex, first, kind, role: e ? e.role : null, label: e && kind !== 'choose' ? e.label || '' : '', keys: e ? e.keys : undefined, value: e ? e.to : undefined, say: p.say };
    });
  }

  const events = new Map((skill.session.events || []).map((e) => [e.id, e]));
  const actions = [];
  skill.map.steps.forEach((step, stepIndex) => {
    // Getting somewhere: one action, never the route the expert happened to take.
    if (step.kind === 'go' && step.destination) {
      actions.push({ stepIndex, first: true, kind: 'go', role: null, label: '', destination: step.destination });
      return;
    }
    const evs = step.event_ids.map((id) => events.get(id)).filter((e) => e && (e.type === 'click' || e.type === 'edit' || e.type === 'shortcut'));
    let first = true;
    for (const e of evs) {
      const prev = actions[actions.length - 1];
      if (prev && prev.stepIndex === stepIndex && prev.kind === e.type && prev.label === e.label) continue; // repeated click
      const free = e.type === 'click' && RECORD_ROLES.has(e.role);
      actions.push({ stepIndex, first, kind: free ? 'any-click' : e.type, role: e.role, label: e.label || '', keys: e.keys, value: e.to });
      first = false;
    }
    // A step with nothing to click (e.g. "check the total") still gets said; any change moves on.
    if (first) actions.push({ stepIndex, first: true, kind: 'look', role: null, label: '' });
  });
  return actions;
}

// What to say for an action. The first action of a step uses the Work Map's own
// wording and the expert's reason; follow-ups within the step are short.
function lineFor(action, skill, opts = {}) {
  if (action.say) return action.say;
  const step = skill.map.steps[action.stepIndex];
  if (action.first) {
    let line = step.action.trim();
    if (step.is_judgment && step.reason) line += ` ${step.reason.trim()}`;
    // One option at a fork, not decided yet: offered, not instructed.
    if (optionOf(step) && !opts.chosen?.has(optionOf(step))) line = `Only if you want ${optionOf(step)}: ${line} Otherwise say skip.`;
    return line;
  }
  if (action.kind === 'go') return `Now get to ${action.destination ? action.destination.name : 'the next screen'}.`;
  if (action.kind === 'edit') return `Now fill in ${action.label}.`;
  if (action.kind === 'shortcut') return `Now press ${spokenKeys(action.keys)}.`;
  if (action.role === 'AXMenuItem') return `Then choose ${action.label}.`;
  return `Now click ${action.label}.`;
}

// Guardrails for the step, shown under the spoken line.
function noteFor(action, skill) {
  if (!action.first) return '';
  const step = skill.map.steps[action.stepIndex];
  return step.guardrails.map((g) => g.text).join(' ');
}

// Find the element for an action on the current screen.
function locate(action, elements) {
  if (!action.label) return null;
  const want = normalize(action.label);
  const sameRole = elements.filter((e) => normalize(e.label) === want && e.role === action.role);
  if (sameRole.length) return sameRole.sort((a, b) => (a.z || 0) - (b.z || 0))[0];
  const sameLabel = elements.filter((e) => normalize(e.label) === want);
  if (sameLabel.length) return sameLabel.sort((a, b) => (a.z || 0) - (b.z || 0))[0];
  const fuzzy = findBest(action.label, elements);
  return fuzzy.match && fuzzy.score >= 0.85 ? fuzzy.match : null;
}

// Is the user at a "go" destination? The app's name, the site's address in an
// address bar, or the site's name in the window title all count.
function atDestination(scan, dest) {
  if (!scan || !dest) return false;
  const app = normalize(scan.app || '');
  if (dest.app && !dest.url) return app === normalize(dest.app) || app.startsWith(normalize(dest.app));
  let host = '';
  try {
    host = dest.url ? new URL(dest.url).hostname.replace(/^www\./, '') : '';
  } catch {}
  const title = normalize(scan.window || '');
  if (host && (scan.elements || []).some((e) => typeof e.value === 'string' && e.value.toLowerCase().includes(host))) return true;
  const name = normalize(dest.name || '').replace(/\b(website|site|app|page|the)\b/g, '').trim();
  return Boolean(name) && title.includes(name);
}

// The first thing to click after `index` that has a label, if it's on screen already.
function nextTargetVisible(actions, index, elements) {
  for (let i = index + 1; i < actions.length; i++) {
    const a = actions[i];
    if (a.kind === 'go') return false;
    if (!a.label || a.kind === 'shortcut') continue;
    return Boolean(locate(a, elements || []));
  }
  return false;
}

const inside = (x, y, r, pad = 6) => x >= r.x - pad && y >= r.y - pad && x <= r.x + r.w + pad && y <= r.y + r.h + pad;

class Replay {
  // deps:
  //   skill            { map, session }
  //   scan()           front-window scan
  //   emit(step)       { status, say, note, target, stepNumber, totalSteps }
  //   thinking()       show that Claude is being asked
  //   recover(note, scan) -> { status, say, target, stepNumber } from Claude, grounded in the skill
  constructor({ skill, plan, scan, emit, thinking = () => {}, recover }) {
    this.skill = skill;
    this.scanFn = scan;
    this.emit = emit;
    this.thinking = thinking;
    this.recover = recover;
    this.actions = buildActions(skill, plan);
    this.index = 0;
    this.running = false;
    this.latest = null;
    this.target = null; // element being pointed at
    this.view = null;
    this.baseValue = null;
    this.editSeenAt = 0;
    this.lostSince = 0;
    this.recovering = false;
    this.recoveries = 0;
    this.wakeScan = null;
    this.aheadAtStart = new Set(); // later actions already on screen when this one was pointed at
    this.skipped = new Set(); // step indexes the user chose to leave out
    this.chosen = new Set(); // options at a fork they've taken (src/forks.js)
    this.progressAt = Date.now(); // when an action was last completed
    // Set by a tutor (src/tutor.js) to hear about the user going off the path:
    //   onOffPath(why)  they did something other than the current action
    //   onLost(why)     the thing for the current action isn't on screen
    this.onOffPath = null;
    this.onLost = null;
    //   judge(action, field, scan) -> { ok, say }: at a judgment call or a step
    //   with guardrails, is what they filled in right for the case in front of
    //   them? Until it says ok, the lesson doesn't move on.
    this.judge = null;
    this.judging = false;
    //   expect(action, scan) -> { expected: [values], sayIfWrong }: worked out
    //   in the background as soon as a decision step comes up, so the check
    //   when they fill it in is instant. Used only while the screen still
    //   shows the same thing (the same record); otherwise judge() decides.
    this.expect = null;
    this.expectation = null; // { index, view, promise, result }
    //   concern(action, scan) -> { flag, say, target }: as a step with
    //   guardrails (that isn't a decision to fill in) comes up, whether the
    //   record on screen triggers one; if so it's said before they act.
    this.concern = null;
    //   onJudged(action, field, verdict): a decision was checked ({ ok, say, praise }).
    this.onJudged = null;
  }

  // Steps where what's entered is a decision, not just a click: the expert's
  // judgment calls and anything with a guardrail.
  needsJudging(a) {
    const step = this.skill.map.steps[a.stepIndex];
    return Boolean(step && (step.is_judgment || (step.guardrails || []).length));
  }

  // Work out, in the background, what the expert's reasoning says belongs in
  // this decision's field for the record on screen.
  prepareExpectation(a) {
    if (!this.expect || !this.latest || a.kind !== 'edit' || !this.needsJudging(a)) return;
    const exp = { index: this.index, view: this.viewOf(this.latest), result: null };
    exp.promise = Promise.resolve(this.expect(a, this.latest))
      .then((r) => (exp.result = r || { expected: [] }))
      .catch(() => (exp.result = { expected: [] }));
    this.expectation = exp;
  }

  // A step with guardrails (not a decision to fill in, which judge() checks):
  // ask once, in the background, whether this record triggers one, and say
  // so before they act. Only on the step's first action, only once.
  checkConcern(a) {
    if (!this.concern || !this.latest || !a.first || a.kind === 'edit') return;
    const step = this.skill.map.steps[a.stepIndex];
    if (!step || !(step.guardrails || []).length) return;
    this.concerned = this.concerned || new Set();
    if (this.concerned.has(a.stepIndex)) return;
    this.concerned.add(a.stepIndex);
    const at = this.index;
    Promise.resolve(this.concern(a, this.latest))
      .then((r) => {
        if (!r || !r.flag || !this.running || this.index !== at) return;
        this.emit({ status: 'step', say: r.say, note: '', target: r.target || this.target, stepNumber: a.stepIndex + 1, totalSteps: this.total, chat: true, flagged: true });
      })
      .catch(() => {});
  }

  // The verdict from the expectation, if it applies and is ready within a
  // moment; null to ask judge() instead.
  async quickVerdict(field, s) {
    const exp = this.expectation;
    if (!exp || exp.index !== this.index || exp.view !== this.viewOf(s)) return null;
    const r = exp.result || (await Promise.race([exp.promise, new Promise((resolve) => setTimeout(() => resolve(null), 2500))]));
    if (!r || !Array.isArray(r.expected) || !r.expected.length) return null;
    const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[\s._-]/g, '').replace(/^0+(?=\d)/, '');
    if (r.expected.some((v) => norm(v) === norm(field.value))) return { ok: true, say: '', praise: r.sayIfRight || '' };
    return r.sayIfWrong ? { ok: false, say: r.sayIfWrong } : null;
  }

  // Check a filled-in decision before moving on. Wrong for this case: say why
  // (in the expert's reasoning) and wait for them to change it, then check again.
  async checkJudgment(a, field, s) {
    this.judging = true;
    let verdict = { ok: true, say: '' };
    try {
      const quick = await this.quickVerdict(field, s);
      if (quick) verdict = quick;
      else {
        this.thinking();
        verdict = (await this.judge(a, field, s)) || verdict;
      }
    } catch (err) {
      console.error('[replay] judgment check', err.message);
    } finally {
      this.judging = false;
    }
    if (!this.running || this.action !== a) return;
    if (this.onJudged) this.onJudged(a, field, verdict);
    if (verdict.ok) return this.complete();
    // Wait for a different value, then check that one.
    this.target = field;
    this.baseValue = field.value;
    this.editSeenAt = 0;
    this.progressAt = Date.now();
    this.emit({ status: 'step', say: verdict.say, note: '', target: field, stepNumber: a.stepIndex + 1, totalSteps: this.total, chat: true, flagged: true });
  }

  get total() {
    return this.skill.map.steps.length;
  }

  lines() {
    return [...new Set(this.actions.map((a) => lineFor(a, this.skill)))];
  }

  async start() {
    this.running = true;
    this.loop();
    await this.freshScan();
    this.point();
  }

  stop() {
    this.running = false;
    if (this.wakeScan) this.wakeScan();
  }

  async loop() {
    while (this.running) {
      try {
        const s = await this.scanFn();
        if (this.running && !s.error) this.onScan(s);
      } catch (err) {
        console.error('[replay] scan', err.message);
      }
      await new Promise((r) => {
        this.wakeScan = r;
        setTimeout(r, 450);
      });
    }
  }

  // Scan right now (after an action) instead of waiting for the next tick.
  async freshScan() {
    try {
      const s = await this.scanFn();
      if (!s.error) this.latest = s;
    } catch {}
  }

  get action() {
    return this.actions[this.index];
  }

  viewOf(s) {
    return `${s.app}|${s.window || ''}`;
  }

  // Point at the current action's element, or keep looking until it shows up.
  // `say` replaces the scripted line (a tutor already said what to do).
  point({ say = null, target = null } = {}) {
    if (!this.running || !this.action) return;
    if (this.skipped.has(this.action.stepIndex)) return this.complete(0);
    const a = this.action;
    // Already where this step gets to? Carry straight on without a word.
    if (a.kind === 'go' && this.arrived(this.latest)) {
      this.complete(0);
      return;
    }
    this.target = target || (this.latest ? locate(a, this.latest.elements) : null);
    this.baseValue = this.target ? this.target.value : null;
    this.editSeenAt = 0;
    this.view = this.latest ? this.viewOf(this.latest) : null;
    this.lostSince = this.target || !a.label || a.kind === 'any-click' ? 0 : Date.now();
    this.aheadAtStart = new Set(this.upcoming().filter((i) => this.latest && locate(this.actions[i], this.latest.elements)));
    this.prepareExpectation(a);
    this.checkConcern(a);
    // What later fields hold now, so typing in one counts as having moved on.
    this.aheadValues = new Map(
      this.upcoming()
        .filter((i) => this.actions[i].kind === 'edit')
        .map((i) => [i, this.latest ? (locate(this.actions[i], this.latest.elements) || {}).value : undefined])
    );
    this.emit({
      status: 'step',
      say: say != null ? say : lineFor(a, this.skill, { chosen: this.chosen }),
      note: noteFor(a, this.skill),
      target: this.target,
      stepNumber: a.stepIndex + 1,
      totalSteps: this.total,
      repeat: !a.first,
    });
  }

  arrived(s) {
    const a = this.action;
    return Boolean(s && a && (atDestination(s, a.destination) || nextTargetVisible(this.actions, this.index, s.elements)));
  }

  // The next few actions with something to find on screen (not past a "go").
  upcoming() {
    const out = [];
    let limit = LOOK_AHEAD;
    for (let i = this.index + 1; i < this.actions.length && out.length < limit; i++) {
      const a = this.actions[i];
      if (a.kind === 'go') break;
      if (this.skipped.has(a.stepIndex)) continue;
      if (!a.label || a.kind === 'shortcut') continue;
      out.push(i);
      // An option nobody's taken yet doesn't use up the look-ahead: what comes
      // after it is where someone not taking it goes next.
      const o = optionOf(this.skill.map.steps[a.stepIndex]);
      if (o && !this.chosen.has(o)) limit++;
    }
    return out;
  }

  // Already past this action? Something a later action needs has appeared since
  // it was pointed at (the menu it opens, the page it leads to): however they
  // did it, and even mid-sentence, they're there. Returns that action's index or -1.
  aheadOf(s) {
    const focus = s.focused && normalize(s.focused.label || '');
    for (const i of this.upcoming()) {
      const later = this.actions[i];
      // Working on a later field: the keyboard's in it, or it's been typed in.
      if (later.kind === 'edit') {
        if (focus && focus === normalize(later.label)) return i;
        const f = locate(later, s.elements);
        if (f && this.aheadValues && this.aheadValues.has(i) && f.value !== this.aheadValues.get(i)) return i;
      }
      if (this.aheadAtStart.has(i)) continue;
      if (locate(later, s.elements)) return i;
    }
    return -1;
  }

  // "Done" (the button, or saying so): they say this step is done. A decision
  // is still checked first; anything else moves straight on.
  done() {
    if (!this.running || this.recovering || this.judging || !this.action) return;
    const a = this.action;
    if (a.kind === 'edit' && this.judge && this.needsJudging(a)) {
      const field = this.latest && locate(a, this.latest.elements);
      if (field) return this.checkJudgment(a, field, this.latest);
    }
    this.complete(0);
  }

  onScan(s) {
    const prev = this.latest;
    this.latest = s;
    if (!this.running || this.recovering || this.judging || !this.action) return;
    const a = this.action;
    const view = this.viewOf(s);

    if (a.kind !== 'go' && !this.completing) {
      const ahead = this.aheadOf(s);
      // Moving on past a decision they've filled in: check it first, never skip it.
      if (ahead > this.index && a.kind === 'edit' && this.judge && this.needsJudging(a)) {
        const field = locate(a, s.elements);
        if (field && field.value !== this.baseValue) {
          this.checkJudgment(a, field, s);
          return;
        }
      }
      if (ahead > this.index) {
        this.settleForks(ahead);
        this.index = ahead;
        this.recoveries = 0;
        this.progressAt = Date.now();
        const next = this.actions[ahead];
        this.point({ say: `You're ahead of me. ${lineFor(next, this.skill)}` });
        return;
      }
    }

    // Keep the pointer honest as the screen changes (src/track.js): a scroll or
    // a dragged window moves it with the thing; if the thing is gone (they left
    // the window, or scrolled it away) the pointer goes home, and it comes back
    // when the thing does (the waiting branch below finds it again).
    if (this.target && a.label && (a.kind === 'click' || a.kind === 'edit')) {
      const left = this.view && view !== this.view;
      const now = left ? null : follow(this.target, a.label, prev && prev.elements, s.elements);
      if (!now) {
        this.target = null;
        this.editSeenAt = 0;
        // Doing something else for a while: don't ask where they are straight away.
        this.lostSince = Date.now() + (left ? 15000 : 3000);
        this.view = view;
        this.emit({ status: 'step', say: '', note: '', target: null, stepNumber: a.stepIndex + 1, totalSteps: this.total, quietMove: true, retract: true });
        return;
      }
      if (Math.abs(now.x - this.target.x) > MOVED_PX || Math.abs(now.y - this.target.y) > MOVED_PX || Math.abs(now.w - this.target.w) > MOVED_PX) {
        this.target = a.kind === 'edit' ? { ...now, value: this.target.value } : now;
        this.emit({ status: 'step', say: '', note: '', target: now, stepNumber: a.stepIndex + 1, totalSteps: this.total, quietMove: true });
      }
    }

    // However they got there.
    if (a.kind === 'go') {
      if (this.arrived(s)) this.complete(0);
      return;
    }

    // Waiting for the target to appear (a menu opening, a page loading).
    if (!this.target && a.label && a.kind !== 'any-click' && a.kind !== 'shortcut') {
      const found = locate(a, s.elements);
      if (found) {
        this.target = found;
        this.baseValue = found.value;
        this.lostSince = 0;
        this.view = view; // where it's been found is where they are now
        this.emit({ status: 'step', say: '', note: '', target: found, stepNumber: a.stepIndex + 1, totalSteps: this.total, quietMove: true });
        return;
      }
      // Keep looking locally either way; only ask Claude a couple of times per step.
      if (Date.now() - this.lostSince > RETRY_MS && this.recoveries < MAX_RECOVERIES) {
        const why = `I can't see "${a.label}" (needed for step ${a.stepIndex + 1}) on the user's screen.`;
        if (this.onLost) {
          this.recoveries++;
          this.lostSince = Date.now() + 8000; // give the tutor and the user time before the next nudge
          this.onLost(why);
        } else this.askClaude(why);
      }
      return;
    }

    if (a.kind === 'edit' && this.target) {
      const field = locate(a, s.elements);
      // Any change counts, even typing the same value back in (retyping what
      // was already there is still a decision to check).
      if (field && (field.value !== this.baseValue || this.editSeenAt)) {
        if (field.value !== this.target.value) {
          this.target = field;
          this.editSeenAt = Date.now();
        } else if (this.editSeenAt && Date.now() - this.editSeenAt >= SETTLE_MS) {
          if (this.judge && this.needsJudging(a)) this.checkJudgment(a, field, s);
          else this.complete();
        }
      }
      return;
    }

    // Nothing specific to click: any new screen means they've moved on.
    if ((a.kind === 'any-click' || a.kind === 'look' || a.kind === 'choose') && this.view && view !== this.view) this.complete();
  }

  onMouseDown(x, y) {
    if (!this.running || this.recovering || this.judging || !this.action) return;
    const a = this.action;
    // Clicking away from a decision (on the way to Save or Send): check what's
    // in it now, before they move on. With the expectation ready it's instant.
    if (a.kind === 'edit' && this.judge && this.needsJudging(a) && this.latest) {
      const field = locate(a, this.latest.elements);
      if (field && !inside(x, y, field)) return this.checkJudgment(a, field, this.latest);
      return;
    }
    // Clicked what a later step needs: they're already there.
    if (this.latest && !(a.kind === 'edit' && this.judge && this.needsJudging(a))) {
      for (const i of this.upcoming()) {
        const later = this.actions[i];
        if (later.kind !== 'click') continue;
        const t = locate(later, this.latest.elements);
        if (t && inside(x, y, t)) {
          this.settleForks(i);
          this.index = i;
          this.target = t;
          return this.complete(120);
        }
      }
    }
    if (a.kind === 'any-click') return this.complete(150);
    if ((a.kind === 'click') && this.target && inside(x, y, this.target)) return this.complete(120);
    // Clicked something else while a particular button was wanted.
    if (this.onOffPath && (a.kind === 'click' || a.kind === 'shortcut') && this.target) this.onOffPath(`clicked away from "${a.label}"`);
  }

  onKey(shortcut) {
    if (!this.running || this.recovering || !this.action) return;
    const a = this.action;
    if (a.kind === 'shortcut' && shortcut === a.keys) this.complete(150);
  }

  // The user pressed Next: treat the current action as done.
  skip() {
    if (this.running && !this.recovering) this.complete(0);
  }

  // Leave out whole steps (1-based), e.g. a mode the user chose not to try.
  // A step that's one option at a fork takes the rest of that option with it.
  skipSteps(numbers) {
    for (const n of numbers || []) if (Number.isInteger(n) && n >= 1 && n <= this.total) for (const i of branchOf(this.skill.map, n - 1)) this.skipped.add(i);
  }

  // "Skip" said or typed: leave out the step they're on (all of it, and the
  // rest of its option at a fork) and carry on.
  skipHere() {
    if (!this.running || this.recovering || this.judging || !this.action) return;
    this.skipSteps([this.action.stepIndex + 1]);
    this.point();
  }

  // Moving on to action `to` some other way than finishing this one: an option
  // passed over without being taken is left out as a whole; landing inside an
  // option takes it.
  settleForks(to) {
    const steps = this.skill.map.steps;
    const dest = this.actions[to] ? this.actions[to].stepIndex : steps.length;
    const taken = optionOf(steps[dest]);
    if (taken) this.chosen.add(taken);
    for (let i = this.action ? this.action.stepIndex : 0; i < dest; i++) {
      const o = optionOf(steps[i]);
      if (o && !this.chosen.has(o)) this.skipSteps([i + 1]);
    }
  }

  // Options already settled by what they asked for (decideForks): Map option ->
  // 'take' | 'leave' | 'ask'.
  decide(decisions) {
    for (const [option, d] of decisions || []) {
      if (d === 'take') this.chosen.add(option);
      if (d === 'leave') {
        const i = this.skill.map.steps.findIndex((st) => optionOf(st) === option);
        if (i >= 0) this.skipSteps([i + 1]);
      }
    }
  }

  // "Step n of m" along the path they're on (src/forks.js).
  shown(stepNumber) {
    const p = progress(this.skill.map, Math.max(0, (stepNumber || 1) - 1), { skipped: this.skipped, chosen: this.chosen });
    return { shownStep: p.n, shownTotal: p.of };
  }

  // Carry on from the first action of a step (1-based), saying `say` instead of the scripted line.
  async jumpToStep(n, { say = null, target = null } = {}) {
    const at = this.actions.findIndex((x) => x.stepIndex === n - 1 && !this.skipped.has(x.stepIndex));
    if (at < 0 || !this.running) return false;
    if (at > this.index) this.settleForks(at);
    this.index = at;
    this.recoveries = 0;
    await this.freshScan();
    this.point({ say, target });
    return true;
  }

  // Where the lesson is, for a tutor: the step, its action and what's being pointed at.
  where() {
    const a = this.action;
    if (!a) return null;
    return { stepNumber: a.stepIndex + 1, totalSteps: this.total, line: lineFor(a, this.skill, { chosen: this.chosen }), target: this.target ? this.target.label : a.label || null, skipped: [...this.skipped].map((i) => i + 1), chosen: [...this.chosen] };
  }

  async complete(delay = 0) {
    if (this.completing) return;
    this.completing = true;
    this.recoveries = 0;
    this.progressAt = Date.now();
    // Doing a step that's one option at a fork is taking that option.
    const did = this.action && !this.skipped.has(this.action.stepIndex) && optionOf(this.skill.map.steps[this.action.stepIndex]);
    if (did) this.chosen.add(did);
    this.index++;
    // Past any steps the user chose to leave out.
    while (this.index < this.actions.length && this.skipped.has(this.actions[this.index].stepIndex)) this.index++;
    if (this.index >= this.actions.length) {
      this.running = false;
      this.emit({ status: 'done', say: `That's it, you've done it: ${this.skill.map.title}.`, target: null, stepNumber: this.total, totalSteps: this.total });
      this.completing = false;
      return;
    }
    // Give the app a moment to react (menu opening, page changing), then look.
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await this.freshScan();
    this.completing = false;
    this.point();
  }

  // Off the recorded path: let Claude work out where the user is, within the skill.
  async askClaude(why) {
    if (this.recovering || !this.running) return;
    this.recovering = true;
    this.recoveries++;
    this.thinking();
    try {
      const step = await this.recover(`${why} The user may have gone off the recorded path.`, this.latest);
      if (!this.running) return;
      if (step.status !== 'step') {
        this.running = false;
        this.emit({ ...step, totalSteps: this.total });
        return;
      }
      // Pick up the recorded actions from the step Claude says they're on.
      const at = this.actions.findIndex((x) => x.stepIndex === (step.stepNumber || 1) - 1);
      if (at >= 0) this.index = at;
      this.target = step.target;
      this.baseValue = step.target ? step.target.value : null;
      this.view = this.latest ? this.viewOf(this.latest) : null;
      this.lostSince = step.target ? 0 : Date.now() + 4000; // give them time before asking again
      this.emit({ ...step, note: '', totalSteps: this.total });
    } catch (err) {
      if (this.running) this.emit({ status: 'stuck', say: err.say || 'Something went wrong.', target: null, totalSteps: this.total });
      this.running = false;
    } finally {
      this.recovering = false;
    }
  }
}

module.exports = { Replay, buildActions, lineFor, locate, atDestination, nextTargetVisible };
