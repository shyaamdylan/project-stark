// "Organise my workspace" / "clean up my workspace".
//
// Rules (see README → Workspace):
//   - Arranging and minimising happen without asking, and can always be undone.
//   - Closing only ever happens after ONE grouped question, only for windows of
//     apps on the closable list, and never for documents, terminals or calls.
//   - Calls and full-screen windows are never touched.
//   - A save dialog stops all further closing; we never answer it for the user.
//
// The macOS side is injected (inventory/change/ask/area), so this file is pure
// enough to test on any OS — see test/organize.test.js.

const fs = require('fs');
const path = require('path');
const { normalize } = require('./matcher');

// Apps whose windows are safe to close: closing loses nothing that can't be
// reopened (browsers keep history; Finder windows are just views).
const DEFAULT_CLOSABLE = ['Finder', 'Safari', 'Google Chrome', 'Arc', 'Firefox', 'Microsoft Edge', 'Brave Browser',
  'System Settings', 'App Store', 'Preview', 'Photos', 'Music', 'Podcasts', 'News', 'Stocks', 'Weather', 'Maps'];

const TERMINALS = ['Terminal', 'iTerm2', 'iTerm', 'Warp', 'Ghostty', 'kitty', 'Alacritty', 'WezTerm', 'Hyper'];
const CALL_APPS = ['zoom.us', 'FaceTime', 'Microsoft Teams', 'Webex', 'Cisco Webex Meetings', 'Around', 'Tuple'];
const CALL_TITLE = /\b(meet\.google|google meet|zoom meeting|huddle|on a call|webex|teams meeting|facetime)\b|(^|\s)meet\s*[-–]/i;

// Built-in focus profiles. Add your own with JARVIS_WORKSPACE_<NAME>=App, App.
const PROFILES = {
  coding: ['Visual Studio Code', 'Code', 'Cursor', 'Xcode', 'Zed', 'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Android Studio',
    'Sublime Text', 'Nova', 'Claude', ...TERMINALS, 'Simulator', 'Docker Desktop', 'Postman'],
  writing: ['Pages', 'Microsoft Word', 'Notes', 'Obsidian', 'Bear', 'Ulysses', 'iA Writer', 'TextEdit', 'Notion', 'Craft'],
  design: ['Figma', 'Sketch', 'Adobe Photoshop', 'Adobe Illustrator', 'Pixelmator Pro', 'Affinity Designer', 'Framer'],
  email: ['Mail', 'Outlook', 'Microsoft Outlook', 'Spark', 'Superhuman', 'Mimestream'],
  chat: ['Slack', 'Messages', 'Discord', 'WhatsApp', 'Telegram', 'Microsoft Teams', 'Signal'],
  meeting: [...CALL_APPS, 'Notes'],
};
const PROFILE_ALIASES = { code: 'coding', programming: 'coding', dev: 'coding', development: 'coding', work: null,
  write: 'writing', essay: 'writing', mail: 'email', emails: 'email', messages: 'chat', call: 'meeting', meetings: 'meeting' };

// "keep chrome" should match Google Chrome, but "keep google" shouldn't match every Google app.
const GENERIC_APP_WORDS = new Set(['google', 'microsoft', 'adobe', 'studio', 'desktop', 'app', 'apple', 'pro']);

const sameApp = (a, b) => normalize(a) === normalize(b);
const inList = (app, list) => list.some((x) => sameApp(x, app));

// A stable-enough identity for a window across two scans.
function key(w) {
  return `${w.pid}:${w.index}:${w.title}`;
}

function isCall(w) {
  return inList(w.app, CALL_APPS) || CALL_TITLE.test(w.title || '');
}

// Which windows to keep, from the focus words ("coding", "safari and code").
// Returns null when the focus names nothing we can see.
function chooseKeep(windows, focus, profiles = PROFILES) {
  const visible = windows.filter((w) => !w.minimized);
  const words = normalize(focus).split(' ').filter(Boolean);
  if (!words.length) {
    // No focus given: keep what you're using right now (the frontmost app).
    const front = visible.find((w) => w.frontmost) || [...visible].sort((a, b) => (a.z ?? 1e9) - (b.z ?? 1e9))[0];
    return front ? visible.filter((w) => w.pid === front.pid).map(key) : [];
  }
  const keep = new Set();
  const apps = new Set();
  const openApps = new Set(visible.map((w) => normalize(w.app)));
  for (const w of words) {
    // "keep safari and code": an app actually called Code wins over the coding profile.
    if (openApps.has(w)) continue;
    const name = w in PROFILE_ALIASES ? PROFILE_ALIASES[w] : w;
    if (name && profiles[name]) profiles[name].forEach((a) => apps.add(normalize(a)));
  }
  for (const win of visible) {
    if (apps.has(normalize(win.app))) keep.add(key(win));
    // "keep safari and code" / "for the budget doc": match app names and titles.
    const appWords = normalize(win.app).split(' ');
    const appHit = ` ${words.join(' ')} `.includes(` ${appWords.join(' ')} `)
      || words.some((w) => w.length >= 4 && !GENERIC_APP_WORDS.has(w) && appWords.includes(w));
    const titleHit = words.some((w) => w.length >= 3 && !['and', 'the'].includes(w) && normalize(win.title).split(' ').includes(w));
    if (appHit || titleHit) keep.add(key(win));
  }
  if (!keep.size) return null;
  // The window you're looking at right now stays too, unless it's clearly a distraction.
  const front = visible.find((w) => w.frontmost);
  if (front && !profiles.chat?.some((a) => sameApp(a, front.app))) keep.add(key(front));
  return [...keep];
}

// Tile n windows inside `area` ({x,y,width,height}): 1 = full, 2 = halves,
// 3 = big left + two stacked right, 4+ = grid.
function tile(n, area, gap = 8) {
  const { x, y, width: W, height: H } = area;
  const r = (rx, ry, rw, rh) => ({ x: Math.round(rx), y: Math.round(ry), w: Math.round(rw), h: Math.round(rh) });
  if (n <= 0) return [];
  if (n === 1) return [r(x + gap, y + gap, W - gap * 2, H - gap * 2)];
  if (n === 2) {
    const w = (W - gap * 3) / 2;
    return [r(x + gap, y + gap, w, H - gap * 2), r(x + gap * 2 + w, y + gap, w, H - gap * 2)];
  }
  if (n === 3) {
    const w = (W - gap * 3) / 2;
    const h = (H - gap * 3) / 2;
    return [r(x + gap, y + gap, w, H - gap * 2), r(x + gap * 2 + w, y + gap, w, h), r(x + gap * 2 + w, y + gap * 2 + h, w, h)];
  }
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = (W - gap * (cols + 1)) / cols;
  const h = (H - gap * (rows + 1)) / rows;
  return Array.from({ length: n }, (_, i) => r(x + gap + (i % cols) * (w + gap), y + gap + Math.floor(i / cols) * (h + gap), w, h));
}

function canClose(w, closableApps) {
  return inList(w.app, closableApps) && !inList(w.app, TERMINALS) && !isCall(w) && !w.edited && !w.fullscreen
    // A document window (Preview with a PDF is fine, its edits prompt to save) — but never a sheet/dialog.
    && !w.sheet;
}

// Build the plan without touching anything.
function makePlan(windows, keepKeys, area, { cleanup = false, closableApps = DEFAULT_CLOSABLE } = {}) {
  const keepSet = new Set(keepKeys);
  const kept = [];
  const actions = [];
  const closable = [];
  const protectedWins = [];
  for (const w of windows) {
    if (w.minimized) continue;
    if (keepSet.has(key(w))) {
      if (!w.fullscreen) kept.push(w);
      continue;
    }
    // Calls and full-screen spaces stay exactly as they are.
    if (isCall(w) || w.fullscreen) { protectedWins.push(w); continue; }
    if (cleanup && canClose(w, closableApps)) closable.push(w);
    else actions.push({ kind: 'minimize', window: w });
  }
  // Front-most first so the window you're using gets the biggest slot.
  kept.sort((a, b) => (b.frontmost ? 1 : 0) - (a.frontmost ? 1 : 0) || (a.z ?? 1e9) - (b.z ?? 1e9));
  const rects = tile(kept.length, area);
  kept.forEach((w, i) => actions.unshift({ kind: 'frame', window: w, rect: rects[i] }));
  return { kept, actions, closable, protected: protectedWins };
}

// Turn "yes" / "no" / "2" / "1 and 3" / "all but 2" into indexes (0-based) to close.
function parseSelection(answer, n) {
  const t = normalize(answer);
  const all = Array.from({ length: n }, (_, i) => i);
  const nums = (t.match(/\d+/g) || []).map(Number).filter((k) => k >= 1 && k <= n).map((k) => k - 1);
  if (/\b(all|everything|every one) (but|except)\b|\bexcept\b|\bkeep\b/.test(t) && nums.length) return all.filter((i) => !nums.includes(i));
  if (nums.length) return [...new Set(nums)].sort((a, b) => a - b);
  if (/^(y|yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|close (them|all|them all|all of them)|all|please|yes please)$/.test(t)) return all;
  return []; // "no", silence, or anything unclear: close nothing.
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const label = (w) => `${w.app}${w.title && w.title !== w.app ? ` — ${w.title}` : ''}`;

class Organizer {
  // file: where the undo snapshot lives. inventory(): windows. change(op): applies one op,
  // resolves {dialog:true} if a save dialog appeared. ask(question): the user's answer.
  constructor({ file, inventory, change, ask, area, closableApps = DEFAULT_CLOSABLE, profiles = PROFILES, dry = false }) {
    Object.assign(this, { file, inventory, change, ask, area, closableApps, profiles, dry });
  }

  // Overridable so tests can feed in a fixed choice.
  async choose(windows, focus) {
    return chooseKeep(windows, focus, this.profiles);
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }

  async run(text, { cleanup = false, focus = '', stopped = () => false } = {}) {
    const windows = await this.inventory();
    if (!windows.length) return { say: "There aren't any windows to organise." };
    const keepKeys = await this.choose(windows, focus);
    const known = new Set(windows.map(key));
    if (!keepKeys || !keepKeys.length || !keepKeys.some((k) => known.has(k))) {
      // Never minimise everything because we misheard what to keep.
      throw Object.assign(new Error(`I'm not sure which app to keep for "${focus}". Try "organise for coding" or "keep Safari and Code".`), { code: 'NO-KEEP' });
    }
    const plan = makePlan(windows, keepKeys, this.area(), { cleanup, closableApps: this.closableApps });

    // One grouped question for every closure, before anything changes.
    let toClose = [];
    if (plan.closable.length) {
      const list = plan.closable.map((w, i) => `${i + 1}. ${label(w)}`).join('\n');
      const minimising = plan.actions.filter((a) => a.kind === 'minimize').length;
      const q = `I'll keep ${keptNames(plan.kept)}${minimising ? ` and minimise ${plural(minimising, 'other window')}` : ''}. ` +
        `Close ${plan.closable.length === 1 ? 'this' : `these ${plan.closable.length}`} too?\n${list}\nSay yes, no, or the numbers to close.`;
      const picked = parseSelection(await this.ask(q, plan.closable), plan.closable.length);
      if (stopped()) throw Object.assign(new Error('stopped'), { code: 'STOPPED' });
      toClose = picked.map((i) => plan.closable[i]);
      // Anything not picked is minimised instead of left in the way.
      for (const w of plan.closable) if (!toClose.includes(w)) plan.actions.push({ kind: 'minimize', window: w });
    }

    const ops = [...plan.actions, ...toClose.map((w) => ({ kind: 'close', window: w }))];
    if (!ops.length) return { say: 'Your workspace already looks tidy.' };
    if (this.dry) return { say: `Dry run: ${ops.length} changes planned.`, ops };

    // Snapshot before touching anything so Undo can put it all back.
    this.write({
      at: new Date().toISOString(),
      windows: ops.map((o) => ({ ...pick(o.window), closed: o.kind === 'close' })),
    });

    let minimised = 0;
    let arranged = 0;
    const closedWins = [];
    let stoppedAt = null;
    const failed = [];
    let interrupted = false;
    for (const op of ops) {
      // "Stop" mid-way: leave the rest alone (Undo still covers what changed).
      if (stopped()) { interrupted = true; break; }
      if (op.kind === 'close' && stoppedAt) {
        // After a save dialog, don't close anything else; minimise it instead.
        await this.safeChange({ kind: 'minimize', window: op.window }, failed) && minimised++;
        continue;
      }
      const res = await this.safeChange(op, failed);
      if (!res) continue;
      if (op.kind === 'frame') arranged++;
      if (op.kind === 'minimize') minimised++;
      if (op.kind === 'close') {
        if (res.dialog) stoppedAt = op.window;
        else closedWins.push(op.window);
      }
    }
    const closed = closedWins.length;
    this.markClosed(closedWins);

    const parts = [];
    if (arranged) parts.push(`arranged ${keptNames(plan.kept)}`);
    if (minimised) parts.push(`minimised ${plural(minimised, 'window')}`);
    if (closed) parts.push(`closed ${closed}`);
    let say = parts.length ? `${interrupted ? 'Stopped part-way' : 'Done'} — ${parts.join(', ')}.` : 'Nothing changed.';
    if (stoppedAt) say += ` ${stoppedAt.app} asked about saving "${stoppedAt.title}", so I left that to you and stopped closing.`;
    if (plan.protected.length) say += ` I didn't touch ${plural(plan.protected.length, 'call or full-screen window')}.`;
    if (failed.length) say += ` ${plural(failed.length, 'window')} wouldn't move.`;
    say += ' Say "undo" to put it back.';
    return { say, arranged, minimised, closed, stopped: !!stoppedAt, interrupted };
  }

  async safeChange(op, failed) {
    try {
      return (await this.change(op)) || {};
    } catch (e) {
      failed.push(op.window);
      return null;
    }
  }

  markClosed(windows) {
    const snap = this.read();
    if (!snap) return;
    const closedKeys = new Set(windows.map(key));
    snap.windows = snap.windows.map((w) => ({ ...w, closed: closedKeys.has(key(w)) }));
    this.write(snap);
  }

  async undo() {
    const snap = this.read();
    if (!snap || !snap.windows) return { say: "There's nothing to undo." };
    let restored = 0;
    const gone = [];
    for (const w of snap.windows) {
      if (w.closed) { gone.push(w); continue; }
      try {
        await this.change({ kind: 'restore', window: w, rect: w.rect, minimized: w.minimized });
        restored++;
      } catch {
        // The window may have been closed since; skip it.
      }
    }
    try { fs.unlinkSync(this.file); } catch {}
    let say = `Put back ${plural(restored, 'window')}.`;
    if (gone.length) {
      const browsers = gone.filter((w) => /safari|chrome|arc|firefox|edge|brave/i.test(w.app));
      say += ` I can't reopen the ${plural(gone.length, 'window')} I closed`;
      say += browsers.length ? ' — press ⌘⇧T in the browser to bring them back.' : '.';
    }
    return { say, restored };
  }
}

function pick(w) {
  return { app: w.app, pid: w.pid, index: w.index, title: w.title, rect: w.rect, minimized: !!w.minimized };
}

function keptNames(kept) {
  const apps = [...new Set(kept.map((w) => w.app))];
  if (!apps.length) return 'your current window';
  return apps.length <= 2 ? apps.join(' and ') : `${apps.slice(0, -1).join(', ')} and ${apps[apps.length - 1]}`;
}

module.exports = { Organizer, makePlan, chooseKeep, parseSelection, tile, key, canClose, isCall, DEFAULT_CLOSABLE, PROFILES };
