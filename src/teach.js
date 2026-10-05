// A teaching session: the expert does a task while the apprentice watches.
//
// Every second we scan the front window and compare it with the last scan.
// Fields whose value changed become "edit" events (typing is merged until the
// field settles); a new window or a big change becomes a "screen" event; mouse
// clicks are matched to the element under the pointer in the scan taken just
// before. When the expert pauses, Claude may pick one question to ask. When
// they finish, a short debrief fills the gaps and produces the Work Map.

const { describeScreen } = require('./apprentice');

const TICK_MS = 1000;
const SETTLE_MS = 900; // a field must stop changing this long before its edit is recorded
const PAUSE_INPUT_MS = 3500; // no mouse or keyboard for this long...
const PAUSE_EVENT_MS = 2500; // ...and nothing new on screen for this long = a pause
const QUESTION_GAP_MS = 35000; // at least this long between live questions
const MAX_LIVE_QUESTIONS = 5;
const MAX_DEBRIEF_QUESTIONS = 3;

const CLICKABLE = new Set([
  'AXButton', 'AXMenuButton', 'AXPopUpButton', 'AXLink', 'AXTab', 'AXRadioButton', 'AXCheckBox',
  'AXMenuItem', 'AXMenuBarItem', 'AXCell', 'AXRow', 'AXDisclosureTriangle', 'AXComboBox',
]);

const elementKey = (e) => `${e.role}|${e.label}|${Math.round(e.x / 24)}|${Math.round(e.y / 24)}`;
const rectOf = (e) => ({ x: e.x, y: e.y, w: e.w, h: e.h });

class TeachSession {
  // deps:
  //   apprentice  Apprentice (Claude)
  //   scan()      -> front-window scan result
  //   capture()   -> { file, display } screenshot saved for an event, or null
  //   askUser(text, phase) -> answer string ('' when skipped)
  //   status(text) shows progress without asking anything
  constructor({ title, apprentice, scan, capture, askUser, status }) {
    this.title = title;
    this.apprentice = apprentice;
    this.scanFn = scan;
    this.capture = capture;
    this.askUser = askUser;
    this.status = status;

    this.startedAt = Date.now();
    this.events = [];
    this.qas = [];
    this.running = false;
    this.lastScan = null;
    this.baseline = new Map(); // element key -> value
    this.view = null; // app + window title
    this.pending = new Map(); // key -> edit being typed
    this.lastInputAt = Date.now();
    this.lastEventAt = Date.now();
    this.lastQuestionAt = 0;
    this.considered = 0; // events up to this id have been looked at for questions
    this.asking = false;
    this.paused = false; // "off the record"
    this.speaking = false; // the expert is talking right now
    this.speechEndedAt = 0;
  }

  now() {
    return Date.now() - this.startedAt;
  }

  start() {
    this.running = true;
    this.loop();
  }

  async loop() {
    while (this.running) {
      const t0 = Date.now();
      try {
        const scan = await this.scanFn();
        if (this.running && !scan.error) await this.tick(scan);
      } catch (err) {
        console.error('[teach] scan', err.message);
      }
      await new Promise((r) => setTimeout(r, Math.max(150, TICK_MS - (Date.now() - t0))));
    }
  }

  async addEvent(e, { frame = true } = {}) {
    if (this.paused) return null;
    const ev = { id: this.events.length + 1, t: this.now(), ...e };
    this.events.push(ev);
    this.lastEventAt = Date.now();
    if (frame) {
      try {
        ev.frame = await this.capture(ev);
      } catch (err) {
        console.error('[teach] capture', err.message);
      }
    }
    console.log('[teach]', ev.type, ev.label || ev.window || ev.keys || ev.text || '', ev.type === 'edit' ? `${ev.from} → ${ev.to}` : '');
    return ev;
  }

  async tick(scan) {
    const values = new Map();
    const byKey = new Map();
    for (const el of scan.elements) {
      if (!('value' in el)) continue;
      const k = elementKey(el);
      values.set(k, el.value);
      byKey.set(k, el);
    }

    const view = `${scan.app}|${scan.window || ''}`;
    if (view !== this.view) {
      await this.flushEdits(true);
      this.view = view;
      this.baseline = values;
      this.lastScan = scan;
      await this.addEvent({ type: 'screen', app: scan.app, window: scan.window || '' });
      return;
    }

    const changed = [];
    for (const [k, v] of values) {
      if (this.baseline.has(k) && this.baseline.get(k) !== v) changed.push(k);
    }

    if (changed.length > 4) {
      // Lots of fields changed at once: a new record opened, not typing.
      await this.flushEdits(true);
      const sample = changed.slice(0, 4).map((k) => `${byKey.get(k).label}: ${byKey.get(k).value || '(empty)'}`).join('; ');
      await this.addEvent({ type: 'screen', app: scan.app, window: scan.window || '', fields: sample });
    } else {
      const now = Date.now();
      for (const k of changed) {
        const el = byKey.get(k);
        const p = this.pending.get(k);
        if (p) {
          p.to = el.value;
          p.lastAt = now;
          p.el = el;
        } else {
          this.pending.set(k, { from: this.baseline.get(k), to: el.value, lastAt: now, el });
        }
        // Ticking a box or picking an option is instant, no need to wait for typing to settle.
        if (el.role === 'AXCheckBox' || el.role === 'AXRadioButton' || el.role === 'AXPopUpButton') this.pending.get(k).lastAt = 0;
      }
      await this.flushEdits(false);
    }

    this.baseline = values;
    this.lastScan = scan;
    this.maybeAsk();
  }

  async flushEdits(all) {
    const now = Date.now();
    for (const [k, p] of this.pending) {
      if (!all && now - p.lastAt < SETTLE_MS) continue;
      this.pending.delete(k);
      if (p.from === p.to) continue;
      await this.addEvent({ type: 'edit', role: p.el.role, label: p.el.label, from: p.from, to: p.to, rect: rectOf(p.el) });
    }
  }

  // From the global input hook.
  onMouseDown(x, y) {
    this.lastInputAt = Date.now();
    if (!this.running || !this.lastScan) return;
    // The smallest clickable thing under the pointer, as it was just before the click.
    let best = null;
    for (const el of this.lastScan.elements) {
      if (!CLICKABLE.has(el.role)) continue;
      if (x < el.x || y < el.y || x > el.x + el.w || y > el.y + el.h) continue;
      if (!best || el.w * el.h < best.w * best.h) best = el;
    }
    if (best) this.addEvent({ type: 'click', role: best.role, label: best.label, rect: rectOf(best) });
  }

  onKey(shortcut) {
    this.lastInputAt = Date.now();
    if (this.running && shortcut) this.addEvent({ type: 'shortcut', keys: shortcut });
  }

  setOffRecord(off) {
    this.paused = off;
  }

  onSpeaking(on) {
    this.speaking = on;
    this.lastInputAt = Date.now();
    if (!on) this.speechEndedAt = Date.now();
  }

  // Something the expert said while working. Returns a voice command
  // ('finish', 'off', 'on') when it was one; otherwise it becomes part of the lesson.
  onNarration(text) {
    this.lastInputAt = Date.now();
    const t = text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(ok(ay)? )?(i'?m|i am|we'?re|we are) (done|finished)\b|^(that'?s it|finish( recording)?|stop recording)\b/.test(t)) return 'finish';
    if (/\boff the record\b/.test(t)) return 'off';
    if (/\b(back )?on the record\b|\bresume recording\b/.test(t)) return 'on';
    if (!this.paused) this.addEvent({ type: 'say', text }, { frame: false });
    return null;
  }

  // ---------- live questions ----------

  isPaused() {
    const now = Date.now();
    return (
      !this.speaking &&
      now - this.speechEndedAt >= PAUSE_EVENT_MS &&
      now - this.lastInputAt >= PAUSE_INPUT_MS &&
      now - this.lastEventAt >= PAUSE_EVENT_MS &&
      this.pending.size === 0
    );
  }

  async maybeAsk() {
    if (this.asking || this.paused || !this.isPaused()) return;
    if (Date.now() - this.lastQuestionAt < QUESTION_GAP_MS) return;
    const live = this.qas.filter((q) => q.phase === 'live').length;
    if (live >= MAX_LIVE_QUESTIONS) return;
    const fresh = this.events.filter((e) => e.id > this.considered && (e.type === 'edit' || e.type === 'click' || e.type === 'shortcut'));
    if (!fresh.length) return;

    this.asking = true;
    const recentFrom = this.considered + 1;
    this.considered = this.events.length;
    try {
      const pick = await this.apprentice.pickQuestion({
        title: this.title,
        events: this.events,
        recentFrom,
        qas: this.qas,
        screen: describeScreen(this.lastScan ? this.lastScan.elements : []),
        asked: live,
      });
      if (!pick.ask || !this.running) return;
      // They may have carried on working while Claude thought; wait for the next pause.
      for (let i = 0; i < 20 && this.running && !this.isPaused(); i++) await new Promise((r) => setTimeout(r, 500));
      if (!this.running || !this.isPaused()) return;
      this.lastQuestionAt = Date.now();
      const t = this.now();
      const answer = await this.askUser(pick.question, 'live');
      this.qas.push({ id: this.qas.length + 1, t, phase: 'live', kind: pick.kind, question: pick.question, answer, event_ids: pick.event_ids });
      this.lastInputAt = Date.now();
      this.lastQuestionAt = Date.now();
    } catch (err) {
      console.error('[teach] question', err.message);
    } finally {
      this.asking = false;
    }
  }

  // ---------- finishing: debrief and Work Map ----------

  async finish() {
    this.running = false;
    await this.flushEdits(true);
    while (this.asking) await new Promise((r) => setTimeout(r, 200));

    this.status('Let me think about what I saw…');
    const draft = await this.apprentice.draftMap({ title: this.title, events: this.events, qas: this.qas });

    const open = draft.open_questions.slice(0, MAX_DEBRIEF_QUESTIONS);
    for (let i = 0; i < open.length; i++) {
      const t = this.now();
      const answer = await this.askUser(open[i], `debrief ${i + 1}/${open.length}`);
      this.qas.push({ id: this.qas.length + 1, t, phase: 'debrief', kind: 'debrief', question: open[i], answer, event_ids: [] });
    }

    const reply = await this.askUser(`${draft.teach_back}\n\nDid I get that right?`, 'teach-back');
    this.qas.push({ id: this.qas.length + 1, t: this.now(), phase: 'teach-back', kind: 'teach_back', question: draft.teach_back, answer: reply, event_ids: [] });

    this.status('Writing up your Work Map…');
    let map = await this.apprentice.finalizeMap({ title: this.title, events: this.events, qas: this.qas, draft, teachBackReply: reply });
    map.confirmed = !reply || /^(yes|yep|yeah|correct|right|that'?s right|looks good|perfect|exactly)\b/i.test(reply.trim());

    // Tidy it up for other people: drop where this expert happened to start,
    // describe where to get to rather than the route, fill the gaps. If that
    // fails, the untidied map is still a good lesson.
    this.status('Tidying it up so anyone can follow it…');
    try {
      map = await this.apprentice.refineMap({ title: this.title, events: this.events, qas: this.qas, map });
    } catch (err) {
      console.error('[teach] tidy up', err.message);
    }
    return map;
  }

  toJSON() {
    return { title: this.title, startedAt: this.startedAt, events: this.events, qas: this.qas };
  }
}

module.exports = { TeachSession, elementKey };
