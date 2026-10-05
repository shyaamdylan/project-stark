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

const RETRY_MS = 2500; // how long to keep looking for a target before asking Claude
const SETTLE_MS = 900; // a field must stop changing this long to count as filled in
const MAX_RECOVERIES = 2; // Claude calls per step before we just wait quietly (Next still works)

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
function lineFor(action, skill) {
  if (action.say) return action.say;
  const step = skill.map.steps[action.stepIndex];
  if (action.first) {
    let line = step.action.trim();
    if (step.is_judgment && step.reason) line += ` ${step.reason.trim()}`;
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
  point() {
    if (!this.running || !this.action) return;
    const a = this.action;
    // Already where this step gets to? Carry straight on without a word.
    if (a.kind === 'go' && this.arrived(this.latest)) {
      this.complete(0);
      return;
    }
    this.target = this.latest ? locate(a, this.latest.elements) : null;
    this.baseValue = this.target ? this.target.value : null;
    this.editSeenAt = 0;
    this.view = this.latest ? this.viewOf(this.latest) : null;
    this.lostSince = this.target || !a.label || a.kind === 'any-click' ? 0 : Date.now();
    this.emit({
      status: 'step',
      say: lineFor(a, this.skill),
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

  onScan(s) {
    this.latest = s;
    if (!this.running || this.recovering || !this.action) return;
    const a = this.action;
    const view = this.viewOf(s);

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
        this.emit({ status: 'step', say: '', note: '', target: found, stepNumber: a.stepIndex + 1, totalSteps: this.total, quietMove: true });
        return;
      }
      // Keep looking locally either way; only ask Claude a couple of times per step.
      if (Date.now() - this.lostSince > RETRY_MS && this.recoveries < MAX_RECOVERIES) {
        this.askClaude(`I can't see "${a.label}" (needed for step ${a.stepIndex + 1}) on the user's screen.`);
      }
      return;
    }

    if (a.kind === 'edit' && this.target) {
      const field = locate(a, s.elements);
      if (field && field.value !== this.baseValue) {
        if (field.value !== this.target.value) {
          this.target = field;
          this.editSeenAt = Date.now();
        } else if (this.editSeenAt && Date.now() - this.editSeenAt >= SETTLE_MS) {
          this.complete();
        }
      }
      return;
    }

    // Nothing specific to click: any new screen means they've moved on.
    if ((a.kind === 'any-click' || a.kind === 'look' || a.kind === 'choose') && this.view && view !== this.view) this.complete();
  }

  onMouseDown(x, y) {
    if (!this.running || this.recovering || !this.action) return;
    const a = this.action;
    if (a.kind === 'any-click') return this.complete(150);
    if ((a.kind === 'click') && this.target && inside(x, y, this.target)) this.complete(120);
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

  async complete(delay = 0) {
    if (this.completing) return;
    this.completing = true;
    this.recoveries = 0;
    this.index++;
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
