// Project Alpha — main process.
//
// One transparent, click-through, always-on-top window covers the work area of
// a display. The renderer draws the buddy at the bottom of it. The window only
// accepts the mouse while the cursor is over the buddy or its speech bubble.

const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, systemPreferences, shell, nativeImage, desktopCapturer, session, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { loadConfig } = require('./src/config');
const { scanFrontApp, scanFrontWindow, refocusFrontApp, warmUp } = require('./src/finder');
const { Guide, findSkill, planReplay } = require('./src/guide');
const { Replay } = require('./src/replay');
const { Apprentice } = require('./src/apprentice');
const { TeachSession } = require('./src/teach');
const { renderWorkMap } = require('./src/workmap-page');
const { transcribe } = require('./src/stt');
const { pathToFileURL } = require('url');
const { findBest } = require('./src/matcher');
const voice = require('./src/voice');

const ASK_SHORTCUT = 'CommandOrControl+Shift+Space';

let win = null;
let tray = null;
let cfg = null;
let cursorTimer = null;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...display.workArea,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // If the buddy's page ever crashes, bring it straight back instead of leaving nothing on screen.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[app] overlay crashed:', details.reason);
    if (!win.isDestroyed()) win.reload();
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config', {
      voice: cfg.voiceEnabled ? (cfg.elevenLabs.apiKey ? 'elevenlabs' : 'system') : 'off',
      shortcut: '⌘⇧Space',
      wakeWord: cfg.wakeWord,
      wakeEnabled: wakeOn(),
    });
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      win.webContents.send('say', {
        text: "Hi! I need Accessibility permission to see buttons. I've opened System Settings for you.",
        mood: 'worried',
      });
      systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS prompt
    } else {
      win.webContents.send('say', { text: `Hi! Click me or press ⌘⇧Space and tell me what to find.`, mood: 'happy' });
      warmUp();
      prewarmVoice();
    }
  });

  startCursorTracking();
}

// Eyes follow the cursor everywhere, not just over our window, so poll it.
function startCursorTracking() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 50);
}

let overlayInteractive = false;

function focusOverlay() {
  if (!win) return;
  overlayInteractive = true;
  win.setIgnoreMouseEvents(false);
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}

// ⌘⇧Space: start listening (press again to cancel). A held key repeats the
// shortcut, so ignore repeats that arrive within a moment of each other.
let lastListenAt = 0;
function listen(mode = 'ask') {
  if (!win) return;
  const now = Date.now();
  if (now - lastListenAt < 700) return;
  lastListenAt = now;
  win.webContents.send('listen', { mode });
}

// "Hey Alpha": the mic listens in the background for the wake word.
let wakeEnabled = null;
function wakeOn() {
  if (wakeEnabled === null) wakeEnabled = Boolean(cfg.wakeEnabled && cfg.elevenLabs.apiKey);
  return wakeEnabled;
}

function setWake(on) {
  wakeEnabled = Boolean(on && cfg.elevenLabs.apiKey);
  if (win) win.webContents.send('wake', { enabled: wakeEnabled, wakeWord: cfg.wakeWord });
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function openPrompt(prefill = '') {
  if (!win) return;
  focusOverlay();
  win.webContents.send('open-prompt', { prefill: typeof prefill === 'string' ? prefill : '' });
}

// A hidden Dock icon sits just past the screen edge. Point at the edge where it
// will slide in instead.
function onScreen(rect) {
  if (!rect.hidden) return rect;
  const b = screen.getDisplayNearestPoint({ x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) }).bounds;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return { ...rect, x: clamp(rect.x, b.x + 2, b.x + b.width - rect.w - 2), y: clamp(rect.y, b.y + 2, b.y + b.height - rect.h - 2) };
}

// Move the overlay to whichever display contains the target, then return the
// target rect in window-local coordinates.
function toLocal(rect) {
  rect = onScreen(rect);
  const center = { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) };
  const display = screen.getDisplayNearestPoint(center);
  const current = screen.getDisplayMatching(win.getBounds());
  if (display.id !== current.id) {
    win.setBounds(display.workArea);
    win.webContents.send('relocated');
  }
  const b = win.getBounds();
  return { x: rect.x - b.x, y: rect.y - b.y, w: rect.w, h: rect.h };
}

const ROLE_NAMES = {
  AXButton: 'button', AXMenuButton: 'menu button', AXPopUpButton: 'pop-up menu', AXLink: 'link', AXTab: 'tab',
  AXRadioButton: 'option', AXCheckBox: 'checkbox', AXMenuBarItem: 'menu', AXSearchField: 'search box',
  AXTextField: 'text box', AXComboBox: 'box', AXSlider: 'slider', AXStaticText: 'text', AXImage: 'image',
  AXMenuItem: 'menu item', AXDockItem: 'app in your Dock',
};

function stripWake(text) {
  const word = String(cfg.wakeWord || 'alpha').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/ph/g, '(?:ph|f)').replace(/ /g, '[\\s,]+');
  return String(text || '').replace(new RegExp(`^\\s*(?:(?:hey|hi|okay|ok|yo)[\\s,.!]+)?${word}\\b[\\s,.!?-]*`, 'i'), '').trim();
}

ipcMain.handle('ask', async (_e, rawText) => {
  try {
    return await ask(stripWake(rawText));
  } catch (err) {
    console.error('[ask]', err);
    return { ok: false, reason: 'error', say: 'Something went wrong. Try again.' };
  }
});

async function ask(text) {
  let scan;
  try {
    scan = await scanFrontApp({ activate: true });
  } catch (err) {
    console.error('[scan]', err.message);
    if (err.code === 'ACCESSIBILITY') {
      systemPreferences.isTrustedAccessibilityClient(true);
      return { ok: false, reason: 'permission', say: 'I need Accessibility permission first.' };
    }
    if (err.code === 'AUTOMATION') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
      return { ok: false, reason: 'permission', say: 'I need Automation permission first.' };
    }
    return { ok: false, reason: 'error', say: "I couldn't look just now." };
  }

  if (scan.error) return { ok: false, reason: scan.error, say: "I can't see an app window." };

  stopGuide();
  const canGuide = Guide.available(cfg);
  if (canGuide && looksLikeTask(text)) return startGuide(text, scan);

  const result = findBest(text, scan.elements);
  console.log(`[ask] "${text}" across ${(scan.apps || [scan.app]).join(', ')}: ${scan.elements.length} elements, best=`, result.match, result.score.toFixed(2));

  if (!result.match) {
    const what = result.query.phrase || text;
    const hint = result.suggestions.length ? ` Did you mean ${result.suggestions.map((s) => `"${s}"`).join(' or ')}?` : '';
    const notFound = { ok: false, reason: 'not-found', say: `I can't see "${what}".${hint}` };
    // Not a button we can see: it might be the name of a skill it has learned.
    if (canGuide && learnedSkills().length) return startGuide(text, scan, notFound);
    return notFound;
  }

  const m = result.match;
  return {
    ok: true,
    label: m.label,
    role: ROLE_NAMES[m.role] || 'thing',
    app: m.app || scan.app,
    rect: toLocal(m),
    say: m.hidden
      ? `"${m.label}" is in your Dock. Move your pointer to the bottom of the screen to show it.`
      : `There's the "${m.label}" ${ROLE_NAMES[m.role] || ''}${m.app && m.app !== scan.app && m.role !== 'AXDockItem' ? ` in ${m.app}` : ''}!`.replace(' !', '!'),
  };
}

// ---------- guided walkthroughs ----------
//
// "How do I…" questions are matched to a skill it has learned, then played back
// live (src/replay.js): it points at each thing the expert used, and moves on
// the moment the user does it. Claude only steps in when the user goes off the
// recorded path, and even then only within the learned skill.

let replay = null;

function looksLikeTask(text) {
  const t = text.trim().toLowerCase();
  return /^(how|what('s| is) the way|show me how|help( me)?|walk me|teach me|i (want|need|would like) to|can you|could you|guide me|where do i)\b/.test(t);
}

// Skills that finished their debrief and have a Work Map.
function learnedSkills() {
  return listSkills().filter((s) => s.page);
}

const STOPWORDS = new Set('a an the to of in on for and or how do does i me my we you your it this that is are be can could would should please want need like help with using use via from into get got make some new up what where when which show tell let just'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s|e)$/, '');
function words(t) {
  return [...new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem))];
}
// Loose on purpose (transcribe ~ transcribing ~ transcription): it only decides whether Claude is worth asking.
function sharesWords(a, b) {
  const B = words(b);
  const prefix = (x, y) => {
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return i;
  };
  return words(a).some((w) => B.some((x) => x === w || prefix(w, x) >= 6));
}

// The cleaned-up replay plan for a skill, made once by Claude and saved with it.
async function replayPlan(id, skill) {
  const file = path.join(skillDir(id), 'replay.json');
  const saved = readJson(file);
  if (saved) return saved;
  const plan = await planReplay(cfg.anthropicApiKey, skill);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  console.log(`[guide] replay plan for "${skill.map.title}": ${plan.actions.length} actions`);
  return plan;
}

function loadSkill(id) {
  const dir = skillDir(id);
  const map = dir && readJson(path.join(dir, 'workmap.json'));
  const sess = dir && readJson(path.join(dir, 'session.json'));
  return map && sess ? { id, map, session: sess } : null;
}

function stepPayload(step) {
  return {
    ok: true,
    guide: true,
    status: step.status,
    say: step.say,
    note: step.note || '',
    quietMove: Boolean(step.quietMove),
    stepNo: step.stepNumber || 0,
    totalSteps: step.totalSteps || 0,
    label: step.target ? step.target.label : null,
    rect: step.target ? toLocal(step.target) : null,
  };
}

// Walkthroughs only ever follow a skill it has been taught. If none matches,
// say so (or fall back to `otherwise`) rather than improvising a procedure.
async function startGuide(text, scan, otherwise = null) {
  const notLearned = otherwise || {
    ok: false,
    reason: 'not-learned',
    say: "I haven't learned that yet.",
  };
  // Only ask Claude when the request shares a real word with something it has learned.
  const skills = learnedSkills().filter((sk) => sharesWords(text, `${sk.title} ${sk.summary}`));
  if (!skills.length) return notLearned;
  let found;
  try {
    found = await findSkill(cfg.anthropicApiKey, text, skills);
  } catch (err) {
    console.error('[guide] skill lookup', err.message);
    return { ok: false, reason: 'guide', say: "I couldn't check that just now." };
  }
  console.log(`[guide] "${text}" → skill: ${found.id || 'none'} (${found.match})`);
  if (!found.id) return notLearned;
  if (found.match === 'maybe') {
    // Close, but not certain: check before walking them through the wrong thing.
    pendingClarify = { id: found.id, text, at: Date.now() };
    return { ok: true, clarify: true, question: found.question };
  }
  return beginSkill(found.id, text);
}

// After a clarifying question: yes starts the skill, no says so, anything else is a new request.
let pendingClarify = null;
ipcMain.handle('confirm', async (_e, rawText) => {
  try {
    const text = stripWake(rawText);
    const pending = pendingClarify && Date.now() - pendingClarify.at < 60000 ? pendingClarify : null;
    pendingClarify = null;
    if (!pending) return ask(text);
    const t = text.toLowerCase();
    if (/^(no|nope|nah|not really|not quite|wrong|neither)\b/.test(t)) return { ok: false, reason: 'not-learned', say: "Sorry, I can't do that one yet." };
    if (/^(yes|yeah|yep|yup|sure|correct|right|exactly|that'?s (it|right)|it is|i do|please|ok(ay)?)\b/.test(t)) return beginSkill(pending.id, pending.text);
    return ask(text);
  } catch (err) {
    console.error('[confirm]', err);
    return { ok: false, reason: 'error', say: 'Something went wrong. Try again.' };
  }
});

async function beginSkill(id, text) {
  const skill = loadSkill(id);
  if (!skill) return { ok: false, reason: 'not-learned', say: "I haven't learned that yet." };

  let plan = null;
  try {
    if (!readJson(path.join(skillDir(id), 'replay.json'))) win.webContents.send('say', { text: 'Getting that lesson ready…', speak: false });
    plan = await replayPlan(id, skill);
  } catch (err) {
    console.error('[guide] replay plan', err.message); // fall back to the raw recording
  }

  const claude = new Guide(cfg.anthropicApiKey, skill);
  let asked = false;
  const r = new Replay({
    skill,
    plan,
    scan: scanFrontWindow,
    emit: (step) => {
      if (replay !== r) return;
      console.log(`[guide] step ${step.stepNumber || '-'}/${step.totalSteps}:`, step.status, step.target ? step.target.label : '', step.say ? `- ${step.say}` : '');
      win.webContents.send('guide-step', stepPayload(step));
      if (step.status !== 'step') stopGuide();
    },
    thinking: () => win.webContents.send('guide-thinking'),
    recover: async (note, current) => {
      const step = asked ? await claude.next(current, note) : await claude.start(text, current, note);
      asked = true;
      return step;
    },
  });
  replay = r;
  startInputHook();

  // Say every line once in the background so the voice is instant when needed.
  if (cfg.elevenLabs.apiKey) {
    (async () => {
      for (const line of r.lines()) await voice.synthesize(line, cfg, 'happy').catch(() => {});
    })();
  }
  // Let the renderer switch into guide mode before the first step arrives.
  setTimeout(() => r.start(), 150);
  return { ok: true, guide: true, status: 'starting', say: '', title: skill.map.title };
}

function stopGuide() {
  if (!replay) return;
  replay.stop();
  replay = null;
  if (!teach) stopInputHook();
}

ipcMain.on('guide-next', () => {
  if (replay) replay.skip();
});
ipcMain.on('guide-stop', () => stopGuide());

// ---------- teaching sessions (the apprentice watches an expert) ----------

let teach = null; // { session, dir }
const answerWaiters = new Map();
let questionSeq = 0;

// Readable names for the keys we record as shortcuts (⌘S, ⌃⇧P…).
const KEY_NAMES = Object.fromEntries(Object.entries(UiohookKey).map(([name, code]) => [code, name]));

function shortcutName(e) {
  if (!e.metaKey && !e.ctrlKey) return null;
  const name = KEY_NAMES[e.keycode];
  if (!name || /^(Meta|Ctrl|Alt|Shift)/.test(name)) return null;
  return `${e.ctrlKey ? '⌃' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${e.metaKey ? '⌘' : ''}${name.length === 1 ? name.toUpperCase() : name}`;
}

let hookRunning = false;
function startInputHook() {
  if (hookRunning) return;
  uIOhook.removeAllListeners();
  uIOhook.on('mousedown', () => {
    // Clicks on our own bubble aren't part of the task.
    if (overlayInteractive) return;
    // Take the position from the system cursor, in the same screen points the scanner uses.
    const p = screen.getCursorScreenPoint();
    if (teach) teach.session.onMouseDown(p.x, p.y);
    if (replay) replay.onMouseDown(p.x, p.y);
  });
  uIOhook.on('keydown', (e) => {
    if (overlayInteractive) return;
    const keys = shortcutName(e);
    if (teach) teach.session.onKey(keys);
    if (replay) replay.onKey(keys);
  });
  uIOhook.start();
  hookRunning = true;
}

function stopInputHook() {
  if (!hookRunning) return;
  uIOhook.stop();
  hookRunning = false;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
}

// Screenshot of the display under the event, saved next to the Work Map.
async function captureFrame(dir, ev) {
  const at = ev.rect ? { x: Math.round(ev.rect.x + ev.rect.w / 2), y: Math.round(ev.rect.y + ev.rect.h / 2) } : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(at);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.size.width, height: display.size.height } });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  const file = `frames/e${ev.id}.jpg`;
  await fs.promises.writeFile(path.join(dir, file), src.thumbnail.toJPEG(78));
  const b = display.bounds;
  return { file, display: { x: b.x, y: b.y, w: b.width, h: b.height } };
}

// Show a question in the bubble and wait for the typed answer ('' if skipped).
function askUser(text, phase) {
  const id = ++questionSeq;
  return new Promise((resolve) => {
    answerWaiters.set(id, resolve);
    // Answers are spoken, so the app you're working in keeps the keyboard.
    win.webContents.send('teach-question', { id, text, phase });
  });
}

ipcMain.on('teach-answer', (_e, { id, text }) => {
  const resolve = answerWaiters.get(id);
  if (!resolve) return;
  answerWaiters.delete(id);
  resolve((text || '').trim());
});

function startTeach(title) {
  if (teach) return;
  if (!Guide.available(cfg)) {
    win.webContents.send('say', { text: 'I need an Anthropic API key to learn. Add ANTHROPIC_API_KEY to the .env file.', mood: 'worried' });
    return;
  }
  const name = (title || '').trim() || 'Untitled task';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dir = path.join(app.getPath('userData'), 'workmaps', `${stamp}-${slug(name)}`);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });

  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    console.warn('[teach] Screen Recording permission not granted: screenshots will be blank until you allow it.');
  }

  const session = new TeachSession({
    title: name,
    apprentice: new Apprentice(cfg.anthropicApiKey),
    scan: scanFrontWindow,
    capture: (ev) => captureFrame(dir, ev),
    askUser,
    status: (text) => win.webContents.send('teach-status', { text }),
  });
  teach = { session, dir };
  stopGuide();
  startInputHook();
  session.start();
  console.log(`[teach] started "${name}" → ${dir}`);
  win.webContents.send('teach-state', { recording: true, title: name, startedAt: session.startedAt });
  win.webContents.send('say', { text: "I'm watching. Work as you normally would, and I'll ask a few questions when you pause. Press Finish when you're done.", mood: 'happy' });
  refocusFrontApp();
}

async function finishTeach() {
  if (!teach || !teach.session.running) return;
  const { session, dir } = teach;
  win.webContents.send('teach-state', { recording: false, debrief: true, title: session.title });
  if (!replay) stopInputHook();
  try {
    const map = await session.finish();
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session.toJSON(), null, 2));
    fs.writeFileSync(path.join(dir, 'workmap.json'), JSON.stringify(map, null, 2));
    const page = path.join(dir, 'index.html');
    fs.writeFileSync(page, renderWorkMap({ map, session: session.toJSON() }));
    console.log(`[teach] Work Map saved: ${page}`);
    // Make the replay plan now, so the first walkthrough starts instantly.
    replayPlan(path.basename(dir), { map, session: session.toJSON() }).catch((err) => console.error('[teach] replay plan', err.message));
    openHub(path.basename(dir));
    const judg = map.steps.filter((s) => s.is_judgment).length;
    win.webContents.send('say', { text: `Got it. Your Work Map has ${map.steps.length} steps and ${judg} judgment calls. I've opened it for you.`, mood: 'happy' });
  } catch (err) {
    console.error('[teach] finish', err);
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session.toJSON(), null, 2));
    win.webContents.send('say', { text: "Sorry, I couldn't write up the Work Map. Your recording is saved, so we can try again.", mood: 'worried' });
  } finally {
    teach = null;
    win.webContents.send('teach-state', { recording: false, title: '' });
  }
}

function setOffRecord(off) {
  if (!teach) return;
  teach.session.setOffRecord(off);
  win.webContents.send('teach-state', { recording: true, offRecord: off, title: teach.session.title, startedAt: teach.session.startedAt });
}

ipcMain.on('teach-narrate', (_e, text) => {
  if (!teach || !teach.session.running) return;
  const cmd = teach.session.onNarration(text);
  if (cmd === 'finish') finishTeach();
  else if (cmd === 'off') setOffRecord(true);
  else if (cmd === 'on') setOffRecord(false);
});
ipcMain.on('teach-speaking', (_e, on) => {
  if (teach) teach.session.onSpeaking(Boolean(on));
});
ipcMain.handle('transcribe', async (_e, wav) => {
  try {
    return await transcribe(Buffer.from(wav), cfg);
  } catch (err) {
    console.error('[stt]', err.message);
    return '';
  }
});

ipcMain.on('teach-start', (_e, title) => startTeach(title));
ipcMain.on('teach-finish', () => finishTeach());
ipcMain.on('teach-off-record', (_e, off) => setOffRecord(Boolean(off)));

// ---------- skills hub ----------

let hub = null;
const workmapsDir = () => path.join(app.getPath('userData'), 'workmaps');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listSkills() {
  const root = workmapsDir();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(root, d.name);
      const map = readJson(path.join(dir, 'workmap.json'));
      const sess = readJson(path.join(dir, 'session.json'));
      const page = path.join(dir, 'index.html');
      const steps = map ? map.steps : [];
      return {
        id: d.name,
        title: (map && map.title) || (sess && sess.title) || d.name,
        summary: (map && map.summary) || '',
        createdAt: (sess && sess.startedAt) || fs.statSync(dir).birthtimeMs,
        steps: steps.length,
        judgments: steps.filter((st) => st.is_judgment).length,
        guardrails: steps.reduce((n, st) => n + st.guardrails.length, 0),
        confirmed: Boolean(map && map.confirmed),
        page: map && fs.existsSync(page) ? pathToFileURL(page).href : null,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Only ever touch folders directly inside the workmaps folder.
function skillDir(id) {
  const dir = path.join(workmapsDir(), path.basename(String(id)));
  return fs.existsSync(dir) ? dir : null;
}

function openHub(selectId) {
  if (hub && !hub.isDestroyed()) {
    hub.show();
    hub.focus();
    if (selectId) hub.webContents.send('hub-changed', selectId);
    return;
  }
  hub = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 500,
    title: 'Skills',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'hub-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  hub.loadFile(path.join(__dirname, 'renderer', 'hub', 'hub.html'));
  if (selectId) hub.webContents.once('did-finish-load', () => hub.webContents.send('hub-changed', selectId));
  hub.on('closed', () => {
    hub = null;
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
}

ipcMain.handle('hub-list', () => listSkills());
ipcMain.handle('hub-delete', async (_e, id) => {
  const dir = skillDir(id);
  if (dir) await shell.trashItem(dir);
  return true;
});
ipcMain.on('hub-reveal', (_e, id) => {
  const dir = skillDir(id);
  if (dir) shell.showItemInFolder(path.join(dir, fs.existsSync(path.join(dir, 'index.html')) ? 'index.html' : ''));
});
ipcMain.on('hub-open-external', (_e, id) => {
  const dir = skillDir(id);
  if (dir) shell.openPath(path.join(dir, 'index.html'));
});
ipcMain.on('hub-teach', () => listen('teach-name'));
ipcMain.on('open-hub', () => openHub());

// Short phrases said while waiting, made ahead so they play instantly.
// Keep in step with FILLERS / ACKS in renderer.js.
const FILLER_LINES = ['Hmm…', 'Let me see…', 'One sec…', 'Okay, let me look…', 'Right…', 'Mm, let me check…', 'Just a moment…', 'Let me think…', 'Okay…', 'Mm-hmm, one second…'];
const ACK_LINES = ['Got it.', 'Okay, makes sense.', 'Thanks, that helps.', 'Mm, okay.', 'Right, got it.', 'Ah, I see.', 'Okay, noted.', 'Perfect, thanks.'];
function prewarmVoice() {
  if (!cfg.elevenLabs.apiKey || !cfg.voiceEnabled) return;
  (async () => {
    for (const line of FILLER_LINES) await voice.synthesize(line, cfg, '').catch(() => {});
    for (const line of ACK_LINES) await voice.synthesize(line, cfg, 'happy').catch(() => {});
  })();
}

ipcMain.handle('speak', async (_e, text) => {
  try {
    const buf = await voice.synthesize(text, cfg);
    return { audio: buf ? buf.toString('base64') : null };
  } catch (err) {
    console.error('[voice]', err.message);
    return { audio: null, error: err.message };
  }
});

ipcMain.on('set-interactive', (_e, interactive) => {
  if (!win) return;
  overlayInteractive = interactive;
  if (interactive) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on('open-prompt', () => openPrompt());

ipcMain.on('prompt-closed', () => {
  if (!win) return;
  overlayInteractive = false;
  win.setIgnoreMouseEvents(true, { forward: true });
  refocusFrontApp(); // hand keyboard focus back to what you were using
});

function buildTrayMenu() {
  return Menu.buildFromTemplate([
      { label: 'Ask buddy (just talk)', accelerator: ASK_SHORTCUT, click: () => listen('ask') },
      { label: 'Teach me a task…', click: () => listen('teach-name') },
      {
        label: `Listen for "Hey ${cfg.wakeWord[0].toUpperCase()}${cfg.wakeWord.slice(1)}"`,
        type: 'checkbox',
        checked: wakeOn(),
        enabled: Boolean(cfg.elevenLabs.apiKey),
        click: (item) => setWake(item.checked),
      },
      { label: 'Open Skills Hub', click: () => openHub() },
      { label: 'Open Accessibility settings', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
      { label: 'Open folder for .env (API keys)', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: 'Quit Project Alpha', role: 'quit' },
    ]);
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('👀');
  tray.setToolTip('Project Alpha');
  tray.setContextMenu(buildTrayMenu());
}

// tts://speak/?text=…&mood=… streams the buddy's voice from ElevenLabs, so the
// renderer can start playing before the whole clip exists. Registered before
// the app is ready, as Electron requires.
protocol.registerSchemesAsPrivileged([
  { scheme: 'tts', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
]);

// One buddy at a time: launching it again just wakes the running one up.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) {
  console.log('Project Alpha is already running. Press ⌘⇧Space to talk to it, or quit it from the 👀 menu first.');
  app.exit(0);
} else {
  app.on('second-instance', () => listen('ask'));
}

if (firstInstance) app.whenReady().then(() => {
  cfg = loadConfig(app.getPath('userData'));
  console.log('[config] loaded from', cfg.loadedFrom.length ? cfg.loadedFrom.join(', ') : '(no .env found)');
  console.log('[config] guide:', Guide.available(cfg) ? 'on (Claude)' : 'off (no ANTHROPIC_API_KEY)');
  console.log('[config] voice:', cfg.voiceEnabled ? (cfg.elevenLabs.apiKey ? 'ElevenLabs' : 'system fallback (no ELEVENLABS_API_KEY)') : 'off');

  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  protocol.handle('tts', async (req) => {
    const u = new URL(req.url);
    try {
      return await voice.stream(u.searchParams.get('text') || '', cfg, u.searchParams.get('mood') || '');
    } catch (err) {
      console.error('[voice]', err.message);
      return new Response('', { status: 502 });
    }
  });

  // The overlay listens to the microphone while you teach it.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  createWindow();
  createTray();

  if (!globalShortcut.register(ASK_SHORTCUT, () => listen('ask'))) {
    console.warn(`[shortcut] ${ASK_SHORTCUT} is taken by another app; use the menu bar 👀 instead.`);
  }

  screen.on('display-metrics-changed', () => {
    if (win) win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea);
  });
});

// Safety net: log unexpected errors instead of crashing the whole app.
process.on('uncaughtException', (err) => console.error('[main] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection', err));

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopInputHook();
});
// A background buddy: closing the Skills Hub (or anything else) never quits it.
// Quit from the 👀 menu instead.
app.on('window-all-closed', () => {});
app.on('before-quit', () => console.log('[app] quitting'));
process.on('exit', (code) => console.log(`[app] exited with code ${code}`));
