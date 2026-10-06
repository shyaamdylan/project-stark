// Project Stark — main process. Two agents share the orb: Friday learns a task
// from one person and teaches it to another; Jarvis does a learned task for you.
//
// One transparent, click-through, always-on-top window covers the work area of
// a display. The renderer draws the buddy at the bottom of it. The window only
// accepts the mouse while the cursor is over the buddy or its speech bubble.

const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, systemPreferences, shell, nativeImage, desktopCapturer, session, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { loadConfig } = require('./src/config');
const { scanFrontApp, scanFrontWindow, refocusFrontApp, warmUp, screenFingerprint } = require('./src/finder');
const { Guide, findSkill, planReplay, locateTarget } = require('./src/guide');
const { buildActions } = require('./src/replay');
const { Tutor, Lesson } = require('./src/tutor');
const { JarvisRun, JarvisFreestyle, planRun, riskOf, isYes } = require('./src/jarvis');
const { Improviser, ImprovisedWalkthrough } = require('./src/improvise');
const { AGENTS, persona, rendererInfo } = require('./src/persona');
const { readTextFile, resolveFile, findFiles, isClear, parseQuery, appRoots, setPicksFile, rememberPick, makeRephrase } = require('./src/files');
const windows = require('./src/windows');
const { correctNames, knownNames } = require('./src/names');
const sessionLog = require('./src/sessionlog');
const { answerAboutScreen, isScreenQuestion } = require('./src/screenqa');
const { needsVision, lookAtScreen, boxToScreen } = require('./src/vision');
const { Conversation } = require('./src/convo');

// The last few exchanges, so a follow-up is understood in light of what came
// before. `turnHistory` is that history as of the request being handled now
// (without the request itself), for the Claude calls it makes.
const convo = new Conversation();
let turnHistory = '';
let lastScreenKey = ''; // app|window of the last scan a request used

// What a reply did, for the conversation memory.
function replyMode(res) {
  if (!res) return { mode: 'none' };
  if (res.looked) return { mode: 'look', target: res.label || '' };
  if (res.guide) return { mode: 'lesson' };
  if (res.jarvis) return { mode: 'task' };
  if (res.clarify) return { mode: 'none' };
  if (res.rect) return { mode: 'point', target: res.label || '' };
  if (res.ok && res.sayOnly) return { mode: 'answer' };
  return { mode: 'none' };
}

function remember(userText, res) {
  convo.add(agent, res && (res.clarify ? res.question : res.say), { ...replyMode(res), window: lastScreenKey });
}
const { screenContext } = require('./src/observe');
const act = require('./src/act');
const textMode = require('./src/textmode');
const runProject = require('./src/runproject');
const { Apprentice, cleanUrl, REFINE_VERSION } = require('./src/apprentice');
const { TeachSession } = require('./src/teach');
const { renderWorkMap } = require('./src/workmap-page');
const { transcribe } = require('./src/stt');
const { pathToFileURL } = require('url');
const { findBest, normalize } = require('./src/matcher');
const voice = require('./src/voice');
const { findNotches, overlayLayout } = require('./src/notch');
const { checkOtherAudio } = require('./src/macaudio');
const { makeStationary } = require('./src/stationary');
const { avoid } = require('./src/avoid');
const usage = require('./src/usage');
// Every Claude call logs its tokens and cost (src/usage.js).
usage.install();
const { follow, moved } = require('./src/track');

const ASK_SHORTCUT = 'CommandOrControl+Shift+Space';

let win = null;
let tray = null;
let cfg = null;
let cursorTimer = null;
let agent = 'friday'; // who you're talking to: 'friday' or 'jarvis'
let notches = []; // MacBook notches on connected screens (src/notch.js)

// Cover a display with the overlay: the whole screen when the orb sits in the
// notch (it draws over the menu bar), else the area under the menu bar.
function placeOverlay(display) {
  const layout = overlayLayout(display, notches, cfg.orbPlace);
  win.setBounds(layout.area);
  // The island only looks like part of the frame if the overlay really reaches
  // the screen's edges; say so if macOS put it somewhere else.
  const got = win.getBounds();
  const want = layout.area;
  if (['x', 'y', 'width', 'height'].some((k) => Math.abs(got[k] - want[k]) > 1)) {
    console.log(`[layout] asked for the overlay at ${want.x},${want.y} ${want.width}×${want.height} but macOS put it at ${got.x},${got.y} ${got.width}×${got.height}`);
  }
  win.webContents.send('layout', { mode: layout.mode, notch: layout.notch });
  return layout;
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...overlayLayout(display, notches, cfg.orbPlace).area,
    // macOS keeps windows below the menu bar unless told otherwise; in the notch the orb sits in it.
    enableLargerThanScreen: true,
    // macOS rounds a frameless window's corners, which would cut the corner
    // island off short of the screen's real corner.
    roundedCorners: false,
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
  // Keep the orb out of screenshots (ours and screen sharing) without hiding it.
  win.setContentProtection(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Stay put in Mission Control, like the menu bar (set after the line above,
  // which rewrites the window's collection behaviour).
  if (makeStationary(win)) console.log('[overlay] the orb stays in its corner in Mission Control');
  win.setIgnoreMouseEvents(true, { forward: true });
  // Everything the orb says or points at goes in the session log (text mode prints its own).
  if (!textMode.enabled()) {
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, payload) => {
      try {
        sessionLog.convoFromSend(channel, payload, agent);
      } catch {}
      send(channel, payload);
    };
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Show the orb's own log lines ("[mic] …") in the terminal too.
  win.webContents.on('console-message', (e) => {
    const text = e.message;
    if (e.level === 'error') console.error('[orb error]', text);
    else if (text && text.startsWith('[')) console.log(text);
  });
  // If the buddy's page ever crashes, bring it straight back instead of leaving nothing on screen.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[app] overlay crashed:', details.reason);
    if (!win.isDestroyed()) win.reload();
  });

  win.webContents.on('did-finish-load', () => {
    placeOverlay(screen.getDisplayMatching(win.getBounds()));
    win.webContents.send('config', {
      voice: cfg.voiceEnabled ? (cfg.elevenLabs.apiKey ? 'elevenlabs' : 'system') : 'off',
      shortcut: '⌘⇧Space',
      wakeWord: cfg.wakeWord,
      wakeEnabled: wakeOn(),
      micOff: Boolean(typed),
      agents: rendererInfo(cfg),
      agent,
      // Speech-to-text needs ElevenLabs; without it, conversations are typed.
      canHear: Boolean(cfg.elevenLabs.apiKey),
      pointerStyle: cfg.pointerStyle,
    });
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      win.webContents.send('say', {
        text: "Hi! I need Accessibility permission to see buttons. I've opened System Settings for you.",
        mood: 'worried',
      });
      systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS prompt
    } else {
      win.webContents.send('say', { text: persona(agent, cfg).greeting, mood: 'happy' });
      warmUp();
      prewarmVoice();
    }
  });

  startCursorTracking();
  watchMacAudio();
}

// Tell the orb when another app is playing sound, so a video talking isn't
// taken for you (see src/macaudio.js).
let macAudioTimer = null;
let macAudio = false;
function watchMacAudio() {
  clearInterval(macAudioTimer);
  macAudioTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    const playing = await checkOtherAudio(app.getAppMetrics().map((m) => m.pid).concat(process.pid));
    if (playing === macAudio) return;
    macAudio = playing;
    console.log(playing ? '[mic] another app is playing sound: only speech that starts with a name counts' : '[mic] the Mac is quiet again');
    win.webContents.send('mac-audio', { playing });
  }, 2000);
}

// Eyes follow the cursor everywhere, not just over our window, so poll it.
function startCursorTracking() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    win.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
    keepIslandClear(p, b);
  }, 50);
  refreshDock();
  setInterval(refreshDock, 15000);
}

// ---------- the corner island keeps clear of the Dock (src/avoid.js) ----------
//
// The renderer reports the island's size; this works out whether the Dock is
// showing over the corner and how far to slide it, and tells the renderer,
// which animates it. Nothing else moves it.
let islandBox = null; // { w, h, interactive } from the renderer
let avoidState = {};
let islandOffset = { x: 0, y: 0 };
let dockInfo = null; // { side, autohide, rect }

ipcMain.on('island-box', (_e, box) => {
  islandBox = box && box.w > 0 ? box : null;
});

function keepIslandClear(p, b) {
  if (!islandBox) return;
  const r = avoid({ island: islandBox, screen: { x: b.x, y: b.y, w: b.width, h: b.height }, dock: dockInfo, cursor: p }, avoidState);
  avoidState = r.state;
  if (r.offset.x === islandOffset.x && r.offset.y === islandOffset.y) return;
  islandOffset = r.offset;
  win.webContents.send('island-offset', { ...islandOffset, edge: r.edge });
}

// Where the Dock is: its side and auto-hide setting, and its frame from
// accessibility (which apps' icons it holds changes its length).
const DOCK_JXA = `var d = Application('System Events').processes.byName('Dock'); var l = d.uiElements[0]; JSON.stringify({ p: l.position(), s: l.size() });`;
function refreshDock() {
  if (process.platform !== 'darwin') return;
  const read = (key) => new Promise((resolve) => execFile('/usr/bin/defaults', ['read', 'com.apple.dock', key], { timeout: 2000 }, (err, out) => resolve(err ? '' : String(out).trim())));
  Promise.all([read('orientation'), read('autohide'), new Promise((resolve) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DOCK_JXA], { timeout: 3000 }, (err, out) => resolve(err ? null : out)))])
    .then(([side, autohide, frame]) => {
      let rect = null;
      try {
        const f = JSON.parse(String(frame));
        if (f && f.s && f.s[0] > 0) rect = { x: f.p[0], y: f.p[1], w: f.s[0], h: f.s[1] };
      } catch {}
      dockInfo = rect ? { side: ['left', 'right'].includes(side) ? side : 'bottom', autohide: autohide === '1', rect } : null;
    })
    .catch(() => {});
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

// "Hey Friday": the mic listens in the background for the wake word.
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

// Switch who you're talking to. The orb changes colour to match (renderer).
// Switching away from Jarvis stops anything he's doing.
function setAgent(id, { announce = false } = {}) {
  if (!AGENTS.includes(id) || id === agent) return;
  agent = id;
  if (id !== 'jarvis') stopJarvis('switch');
  console.log(`[agent] now talking to ${id}`);
  if (win) win.webContents.send('agent', { agent: id });
  if (announce && win) win.webContents.send('say', { text: persona(id, cfg).greeting, mood: 'happy' });
  if (tray) {
    tray.setToolTip(`${persona(id, cfg).name} · Project Stark`);
    tray.setContextMenu(buildTrayMenu());
  }
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
    placeOverlay(display);
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

// "Hey Friday, …" / "Jarvis, …" -> which agent was named (if any) and the rest.
function wakePattern(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/ph/g, '(?:ph|f)').replace(/ /g, '[\\s,]+');
  return new RegExp(`^\\s*(?:(?:hey|hi|okay|ok|yo)[\\s,.!]+)?${w}\\b[\\s,.!?-]*`, 'i');
}
function splitWake(text) {
  const t = String(text || '');
  for (const id of AGENTS) {
    const m = wakePattern(persona(id, cfg).wakeWord).exec(t);
    if (m) return { agent: id, rest: t.slice(m[0].length).trim() };
  }
  return { agent: null, rest: t.trim() };
}
const stripWake = (text) => splitWake(text).rest;

ipcMain.handle('ask', async (_e, rawText, who) => {
  stopTracking();
  sessionLog.convo('You', rawText);
  turnHistory = convo.forPrompt();
  convo.add('user', splitWake(rawText).rest);
  const res = await handleAsk(rawText, who);
  remember(rawText, res);
  trackPointed(res);
  sessionLog.convoFromReply(res, agent);
  return res;
});
async function handleAsk(rawText, who) {
  try {
    const { agent: named, rest } = splitWake(rawText);
    setAgent(named || who);
    // Speech-to-text gets project names wrong ("Piano Scrap"): fix them against
    // names it knows (project folders, apps, learned skills).
    const fixed = correctNames(tidySpeech(rest), knownNames({ extra: learnedSkills().map((sk) => sk.title) }));
    if (fixed.fixes.length) console.log('[ask] heard', fixed.fixes.map(([a, b]) => `"${a}" as ${b}`).join(', '));
    if (!/[a-z0-9]{2}/i.test(fixed.text)) return { ok: false, reason: 'empty', say: persona(agent, cfg).s("Sorry{sir}, I didn't catch that.") };
    return await (agent === 'jarvis' ? askJarvis(fixed.text) : ask(fixed.text));
  } catch (err) {
    console.error('[ask]', err);
    return { ok: false, reason: 'error', say: persona(agent, cfg).s('Something went wrong{sir}. Try again.') };
  }
}

// ---------- keeping the highlight on what it points at (src/track.js) ----------
//
// After an answer points at something, keep checking the front window for a
// little while: if the thing moves (a scroll, the window dragged) the highlight
// follows; if it goes away, or they switch to another window, the highlight goes.
const TRACK_MS = 15000;
const TRACK_EVERY_MS = 900;
let tracking = null;

function stopTracking() {
  if (tracking) clearInterval(tracking.timer);
  tracking = null;
}

function trackPointed(res) {
  stopTracking();
  if (!res || !res.ok || !res.rect || !win) return;
  const b = win.getBounds();
  const t = {
    rect: { x: res.rect.x + b.x, y: res.rect.y + b.y, w: res.rect.w, h: res.rect.h, label: res.label },
    label: res.label,
    picture: res.role === 'part', // a box on a screenshot: it moves with the screen
    prev: null, // the last scan's elements, to see how the screen moved
    key: lastScreenKey,
    until: Date.now() + TRACK_MS,
    busy: false,
  };
  tracking = t;
  t.timer = setInterval(() => trackTick(t), TRACK_EVERY_MS);
}

async function trackTick(t) {
  if (tracking !== t || t.busy) return;
  if (Date.now() > t.until || replay || improv || jarvisRun || teach) return stopTracking();
  t.busy = true;
  try {
    const s = await scanFrontWindow();
    if (tracking !== t || !s || s.error) return;
    // They've gone to another window: the pointing no longer applies, so it goes home.
    const left = `${s.app}|${s.window || ''}` !== t.key;
    // Otherwise follow it by how the screen moved (a scroll, the window dragged),
    // and only if it's really where that movement puts it (src/track.js).
    const first = !t.prev;
    const now = left ? null : first && t.picture ? t.rect : follow(t.rect, t.picture ? '' : t.label, t.prev, s.elements);
    t.prev = s.elements;
    if (!now) {
      console.log(`[track] "${t.label}" ${left ? 'is in a window they left' : 'is gone'}: taking the highlight away`);
      stopTracking();
      if (win) win.webContents.send('unpoint');
      return;
    }
    if (moved(now, t.rect)) {
      t.rect = { ...t.rect, x: now.x, y: now.y, w: now.w, h: now.h };
      if (win) win.webContents.send('repoint', { rect: toLocal(t.rect), label: t.label });
    }
  } catch {
    // A failed scan just waits for the next tick.
  } finally {
    t.busy = false;
  }
}

// ---------- getting ready while they're still talking ----------
//
// The moment the orb hears its name, read the screen (and take the screenshot)
// in the background, so when the sentence ends the request can start straight
// away. It's used only if a quick fingerprint says the screen hasn't changed
// since. No Claude calls, so it costs no tokens.
const PREPARED_MS = 12000;
let prepared = null; // { at, scan, fp, image } (promises)

ipcMain.on('prepare', () => {
  if (prepared && Date.now() - prepared.at < 3000) return;
  const scan = scanFrontApp({ activate: false }).catch(() => null);
  prepared = {
    at: Date.now(),
    scan,
    fp: screenFingerprint().catch(() => null),
    image: scan.then((s) => (s && !s.error && alwaysLook() ? captureFront(s).catch(() => null) : null)),
  };
});

// The scan read while they were talking, if the screen still looks the same.
async function preparedScan() {
  const p = prepared;
  prepared = null;
  if (!p || Date.now() - p.at > PREPARED_MS) return null;
  const [s, then, now] = await Promise.all([p.scan, p.fp, screenFingerprint().catch(() => null)]);
  if (!s || s.error || !then || then !== now) return null;
  console.log(`[ask] using the screen as read while you were talking (${Date.now() - p.at} ms ago)`);
  refocusFrontApp();
  return { ...s, prepared: p };
}

// Scan everything on screen for a request, or a ready-made reply explaining why not.
async function scanForAsk() {
  const ready = await preparedScan();
  if (ready) {
    lastScreenKey = `${ready.app}|${ready.window || ''}`;
    return { scan: ready };
  }
  let scan;
  try {
    scan = await scanFrontApp({ activate: true });
  } catch (err) {
    console.error('[scan]', err.message);
    if (err.code === 'ACCESSIBILITY') {
      systemPreferences.isTrustedAccessibilityClient(true);
      return { reply: { ok: false, reason: 'permission', say: 'I need Accessibility permission first.' } };
    }
    if (err.code === 'AUTOMATION') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
      return { reply: { ok: false, reason: 'permission', say: 'I need Automation permission first.' } };
    }
    return { reply: { ok: false, reason: 'error', say: "I couldn't look just now." } };
  }
  if (scan.error) return { reply: { ok: false, reason: scan.error, say: "I can't see an app window." } };
  lastScreenKey = `${scan.app}|${scan.window || ''}`;
  return { scan };
}

async function ask(text) {
  const { scan, reply } = await scanForAsk();
  if (reply) return reply;

  stopGuide();
  const canGuide = Guide.available(cfg);
  // "Spot me on coding an invoice", "keep an eye on me while I…": Spotter mode.
  const spotted = canGuide && SPOT_ME.exec(text);
  if (spotted) {
    const rest = text.replace(SPOT_ME, ' ').replace(/^\s*(?:on|with|while i(?:'m)?|as i|doing)\s+/i, '').trim();
    return startGuide(rest || text, scan, { ok: false, reason: 'not-learned', say: "I can only spot you on something I've been taught. Teach me it first and I'll keep an eye on you next time." }, scan, { spot: true });
  }
  // Carrying on with what she just did here ("now the left hand" after pointing
  // at the nose in a diagram): do the same kind of thing, before anything else.
  const follow = canGuide ? convo.followUp(text, lastScreenKey) : null;
  if (follow) console.log(`[ask] follow-up to the last ${follow}`);
  if (follow === 'look') {
    const res = await visualAnswer(text, scan, 'friday', 'a follow-up to what was just looked at');
    if (res) return res;
  }
  if (follow === 'answer') {
    const res = await screenAnswer(text, scan, 'friday');
    if (res) return res;
  }
  // Looking at the screen for every question and "show me": a button named
  // exactly as said is pointed at straight away; anything else is answered
  // from a screenshot (exact positions still used where the app gives them).
  if (canGuide && alwaysLook() && (!looksLikeTask(text) || follow)) {
    const quick = exactlyNamed(text, scan);
    if (quick) return quick;
    const res = await visualAnswer(text, scan, 'friday', 'every question is looked at');
    if (res) return res;
  }
  // A picture, a diagram, an app that describes nothing: look before answering.
  if (canGuide && !alwaysLook() && !looksLikeTask(text)) {
    const res = await lookIfNeeded(text, scan, 'friday');
    if (res) return res;
  }
  // "What does this do?": a question about what's in front of them, answered from the screen.
  if (canGuide && isScreenQuestion(text)) {
    const res = await screenAnswer(text, scan, 'friday');
    if (res) return res;
  }
  if (canGuide && looksLikeTask(text) && !follow) {
    const res = await startGuide(text, scan, null, scan);
    if (res.reason !== 'not-learned') return res;
    // Not a learned skill: it may still be one obvious button on screen...
    const one = await locateOnScreen(text, scan);
    if (one.ok) return one;
    // ...and if not, she has a go anyway, and says honestly if she can't.
    return startImprovGuide(text);
  }

  const result = findBest(text, scan.elements);
  console.log(`[ask] "${text}" across ${(scan.apps || [scan.app]).join(', ')}: ${scan.elements.length} elements, best=`, result.match, result.score.toFixed(2));

  if (!result.match) {
    const what = result.query.phrase || text;
    const hint = result.suggestions.length ? ` Did you mean ${result.suggestions.map((s) => `"${s}"`).join(' or ')}?` : '';
    const notFound = { ok: false, reason: 'not-found', say: `I can't see "${what}".${hint}` };
    // Not a button we can see: it might be the name of a skill it has learned.
    if (canGuide && learnedSkills().length) {
      const res = await startGuide(text, scan, notFound);
      if (res !== notFound) return res;
    }
    // Or something accessibility doesn't describe (a part of a picture): look.
    if (canGuide && LOOKABLE.test(text)) {
      const res = await lookIfNeeded(text, scan, 'friday', { missed: true });
      if (res) return res;
    }
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

// Answer a question about the screen, pointing at what it's about. Returns null
// when they actually want something done, so the request carries on as a task.
async function screenAnswer(text, scan, who) {
  let r;
  try {
    r = await answerAboutScreen(cfg.anthropicApiKey, { question: text, scan, agent: who, address: cfg.jarvis.address, history: turnHistory });
  } catch (err) {
    console.error('[screen question]', err.message);
    return null;
  }
  console.log(`[screen question] "${text}" → ${r.kind}${r.target ? ` (pointing at "${r.target.label}")` : ''}${r.needsPicture ? ' (needs a picture)' : ''}`);
  if (r.needsPicture) {
    const seen = await visualAnswer(text, scan, who, "the text description wasn't enough to answer");
    if (seen) return seen;
  }
  if (r.kind !== 'answer' || !r.say) return null;
  if (r.target && !r.target.hidden) return { ok: true, label: r.target.label, role: ROLE_NAMES[r.target.role] || 'thing', rect: toLocal(r.target), say: r.say };
  return { ok: true, sayOnly: true, say: r.say };
}

// ---------- looking at the screen (only when needed) ----------
//
// Accessibility first: it's exact and private. A screenshot of the front window
// only when needsVision() says so (a visual question, an app that describes
// nothing, a big picture or canvas, accessibility coming up empty, or a
// follow-up about something just seen). Used to answer and point, never to click.

let lastLook = null; // { key, at }: what was looked at, for follow-ups
let visionPermissionToldAt = 0;
let visionOn = null;
const visionAllowed = () => (visionOn === null ? cfg.visionEnabled : visionOn) && Guide.available(cfg);

// One JPEG of what they're looking at: the whole display the front window is on
// (SCREEN_AREA=window: just the front window). The overlay is content-protected,
// so the orb never appears in it.
async function captureFront(scan) {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') return { denied: true };
  const fw = scan && scan.frame;
  if (!fw || !fw.w || !fw.h) return null;
  const display = screen.getDisplayMatching({ x: Math.round(fw.x), y: Math.round(fw.y), width: Math.round(fw.w), height: Math.round(fw.h) });
  const whole = cfg.screenArea === 'screen';
  const b = display.bounds;
  const frame = whole ? { x: b.x, y: b.y, w: b.width, h: b.height } : fw;
  const sf = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(b.width * sf), height: Math.round(b.height * sf) } });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  const img = src.thumbnail;
  const k = img.getSize().width / b.width;
  const rect = {
    x: Math.max(0, Math.round((frame.x - b.x) * k)),
    y: Math.max(0, Math.round((frame.y - b.y) * k)),
    width: Math.round(frame.w * k),
    height: Math.round(frame.h * k),
  };
  rect.width = Math.min(rect.width, img.getSize().width - rect.x);
  rect.height = Math.min(rect.height, img.getSize().height - rect.y);
  let shot = img.crop(rect);
  // An image costs tokens by its pixel area (about one per 28×28 square), so
  // it's sent at SCREENSHOT_PX on the long side: a whole screen is still easy
  // to read, at about two thirds of the tokens of Claude's 1568 px maximum.
  const long = Math.max(rect.width, rect.height);
  if (long > cfg.screenshotPx) shot = shot.resize(rect.width >= rect.height ? { width: cfg.screenshotPx } : { height: cfg.screenshotPx });
  const size = shot.getSize();
  return { data: shot.toJPEG(80).toString('base64'), width: size.width, height: size.height, frame, area: whole ? 'screen' : 'window', windows: scan.windows || [] };
}

// Every request looks at the screen, unless set to "smart" (only when needed).
const alwaysLook = () => visionAllowed() && cfg.screenMode === 'always';

// A screenshot for a lesson or best-effort turn, or null (no permission, turned
// off). One capture per moment: turns close together share it.
let lastSnap = null; // { key, at, image }
async function snap(scan) {
  if (!alwaysLook() || !scan || scan.error || !scan.frame) return null;
  const key = `${scan.app}|${scan.window || ''}|${scan.frame.x},${scan.frame.y},${scan.frame.w},${scan.frame.h}`;
  if (lastSnap && lastSnap.key === key && Date.now() - lastSnap.at < 1200) return lastSnap.image;
  let image = null;
  try {
    image = await captureFront(scan);
  } catch (err) {
    console.error('[vision] capture', err.message);
  }
  if (image && image.denied) {
    tellNoScreenRecording();
    return null;
  }
  if (image) {
    lastSnap = { key, at: Date.now(), image };
    console.log(`[vision] looking at ${image.area === 'screen' ? 'the screen, front: ' : ''}${scan.app}${scan.window ? ` — "${scan.window}"` : ''} (${image.width}×${image.height}) because a lesson or task step is being worked out`);
  }
  return image;
}

// Say once (every 10 minutes at most) that screenshots need permission, and open it.
function tellNoScreenRecording() {
  if (Date.now() - visionPermissionToldAt < 10 * 60 * 1000) return;
  visionPermissionToldAt = Date.now();
  console.log("[vision] Screen Recording isn't allowed: going by accessibility only");
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  if (win) win.webContents.send('say', { text: persona(agent, cfg).s("To see your screen I need Screen Recording permission{sir}. I've opened the setting; until then I'll go by what apps describe."), mood: 'worried' });
}

// Look, answer and point. Returns a reply, or null to carry on without it.
async function visualAnswer(text, scan, who, why) {
  if (!visionAllowed() || !scan || scan.error) return null;
  const p = persona(who, cfg);
  let image;
  try {
    // Taken while they were still talking, if the screen hadn't changed since.
    image = (scan.prepared && (await scan.prepared.image)) || (await captureFront(scan));
  } catch (err) {
    console.error('[vision] capture', err.message);
    return null;
  }
  if (image && image.denied) {
    console.log(`[vision] wanted to look (${why}) but Screen Recording isn't allowed`);
    tellNoScreenRecording();
    return null;
  }
  if (!image) return null;
  console.log(`[vision] looking at ${image.area === 'screen' ? 'the screen, front: ' : ''}${scan.app}${scan.window ? ` — "${scan.window}"` : ''} (${image.width}×${image.height}) because ${why}`);
  let r;
  try {
    r = await lookAtScreen(cfg.anthropicApiKey, { question: text, image, scan, agent: who, address: cfg.jarvis.address, history: turnHistory });
  } catch (err) {
    console.error('[vision]', err.message);
    return null;
  }
  lastLook = { key: `${scan.app}|${scan.window || ''}`, at: Date.now() };
  console.log(`[vision] → ${r.kind}${r.point ? ` (pointing at "${r.point.label}")` : ''}`);
  if (r.kind !== 'answer' || !r.say) return null;
  // Exact when it's something accessibility describes; the screenshot spot otherwise.
  if (r.target && !r.target.hidden) return { ok: true, label: r.target.label, role: ROLE_NAMES[r.target.role] || 'thing', rect: toLocal(r.target), say: r.say, looked: true };
  const rect = boxToScreen(r.point, image, image.frame);
  if (rect) return { ok: true, label: rect.label, role: 'part', rect: toLocal(rect), say: r.say, looked: true };
  return { ok: true, sayOnly: true, say: r.say, looked: true };
}

// Look first if the request, the app or the conversation says text won't be enough.
async function lookIfNeeded(text, scan, who, { missed = false } = {}) {
  if (!visionAllowed()) return null;
  const d = needsVision({ text, scan, recent: lastLook, missed });
  return d.need ? visualAnswer(text, scan, who, d.why) : null;
}

// "Share", "where's the export button": a visible control named exactly as
// said. Pointed at instantly, no screenshot or Claude needed.
function exactlyNamed(text, scan) {
  if (text.split(/\s+/).length > 6) return null;
  const r = findBest(text, scan.elements);
  if (!r.match || r.match.hidden || r.score < 0.95) return null;
  const m = r.match;
  return { ok: true, label: m.label, role: ROLE_NAMES[m.role] || 'thing', app: m.app || scan.app, rect: toLocal(m), say: `There's the "${m.label}" ${ROLE_NAMES[m.role] || ''}!`.replace(' !', '!') };
}

// Worth a look when accessibility found nothing: questions and "where/show me" requests, not chit-chat.
const LOOKABLE = /(where|which|what|point|show|find|see|look|this|that|these|those)/i;

// "Can you show me X", "point to X", "where's X": pointing, not a task to walk through.
const SHOW_ME = /^(?:(?:can|could|would) you\s+)?(?:now\s+|please\s+|just\s+|also\s+)*(?:show me|point (?:to|at|out)|highlight|where(?:'s| is| are)?)\b(?!\s+how\b)/i;

function looksLikeTask(text) {
  const t = text.trim().toLowerCase();
  if (SHOW_ME.test(t)) return false;
  return /^(how|what('s| is) the way|show me how|help( me)?|walk me|teach me|i (want|need|would like) to|can you|could you|guide me|where do i|open|go to|search|look up|create|make|change|turn (on|off)|set ?up|add|install|get to|sign (in|up)|log in|download|upload|share|send|save|export|print)\b/.test(t);
}

const GENERIC = new Set(['file', 'files', 'this', 'that', 'thing', 'button', 'page', 'screen', 'app', 'here', 'there', 'one', 'option', 'menu', 'find', 'click', 'press', 'open', 'go', 'see']);
const CLICKABLE_ROLES = new Set(['AXButton', 'AXMenuButton', 'AXPopUpButton', 'AXLink', 'AXTab', 'AXMenuItem', 'AXMenuBarItem', 'AXCheckBox', 'AXRadioButton']);

// One step, no route: point at a button that clearly does the task, if it's on screen.
async function locateOnScreen(text, scan) {
  const notHere = { ok: false, reason: 'not-learned', say: "I can't see that here, and I haven't learned how to get to it." };
  const clickable = scan.elements.filter((e) => CLICKABLE_ROLES.has(e.role) && !e.hidden);
  // Free first: a button labelled exactly with the key word ("export" -> Export).
  const keyWords = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !GENERIC.has(w));
  let el = null;
  for (const w of keyWords) {
    // Exactly the key word only ("Export" for "export"). A label that merely
    // starts with it ("Chat and Cowork" for "chat") is left to the careful check.
    const hits = clickable.filter((e) => {
      const l = normalize(e.label);
      return l === w || l === `${w}s` || l === `${w} ...`;
    });
    if (hits.length) {
      el = hits.sort((a, b) => (a.z || 0) - (b.z || 0) || normalize(a.label).length - normalize(b.label).length)[0];
      break;
    }
  }
  if (!el && keyWords.length) {
    try {
      el = await locateTarget(cfg.anthropicApiKey, text, scan.elements);
    } catch (err) {
      console.error('[locate]', err.message);
    }
  }
  console.log(`[locate] "${text}" →`, el ? `${el.role} "${el.label}"` : 'nothing on screen');
  if (!el) return notHere;
  return { ok: true, label: el.label, role: ROLE_NAMES[el.role] || 'thing', app: el.app || scan.app, rect: toLocal(el), say: `Click ${el.label}.` };
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

// Skills taught before the tidy-up pass existed (or under older rules) are
// tidied the first time they're used. The original stays as workmap.original.json.
//
// It happens once per skill: the tidied map is saved with its version, and a
// skill that's already tidy is never sent again. Untidied skills are done in
// the background at startup (tidyAllSkills) so a run doesn't wait for it; a
// run that does catch one mid-tidy waits for that same tidy-up rather than
// starting another. A failed tidy-up isn't retried until the app restarts.
const tidying = new Map(); // id -> promise of the tidied skill
const tidyFailed = new Set(); // ids that failed this session

function ensureRefined(id, skill, { quiet = false } = {}) {
  if ((skill.map.refined || 0) >= REFINE_VERSION || !Guide.available(cfg) || tidyFailed.has(id)) return Promise.resolve(skill);
  if (tidying.has(id)) return tidying.get(id);
  const job = refineSkill(id, skill, quiet).finally(() => tidying.delete(id));
  tidying.set(id, job);
  return job;
}

async function refineSkill(id, skill, quiet) {
  const dir = skillDir(id);
  if (win && !quiet) win.webContents.send('say', { text: 'Tidying up that lesson first…', speak: false });
  try {
    const map = await new Apprentice(cfg.anthropicApiKey).refineMap({
      title: skill.session.title || skill.map.title,
      events: skill.session.events || [],
      qas: skill.session.qas || [],
      map: skill.map,
    });
    const original = path.join(dir, 'workmap.original.json');
    if (!fs.existsSync(original)) fs.copyFileSync(path.join(dir, 'workmap.json'), original);
    fs.writeFileSync(path.join(dir, 'workmap.json'), JSON.stringify(map, null, 2));
    fs.writeFileSync(path.join(dir, 'index.html'), renderWorkMap({ map, session: skill.session }));
    // Plans made from the old map no longer fit.
    for (const f of ['replay.json', 'jarvis.json']) fs.rmSync(path.join(dir, f), { force: true });
    console.log(`[skills] tidied "${map.title}": ${map.cleanup_notes.join(' | ') || 'nothing to change'}`);
    return { ...skill, map };
  } catch (err) {
    console.error('[skills] tidy up', err.message);
    tidyFailed.add(id);
    return skill;
  }
}

// Tidy any skill taught before the tidy-up existed, one at a time, in the background.
async function tidyAllSkills() {
  for (const s of learnedSkills()) {
    const skill = loadSkill(s.id);
    if (skill && (skill.map.refined || 0) < REFINE_VERSION) await ensureRefined(s.id, skill, { quiet: true });
  }
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
    chat: Boolean(step.chat), // the tutor talking (an answer, a check-in): the cursor stays put
    flagged: Boolean(step.flagged), // a decision she stopped: the field gets the warning highlight
    retract: Boolean(step.retract), // what she pointed at is gone (they left, or scrolled it away): pointer home
    stepNo: step.stepNumber || 0,
    totalSteps: step.totalSteps || 0,
    label: step.target ? step.target.label : null,
    rect: step.target ? toLocal(step.target) : null,
  };
}

// Spotter: watching over their shoulder while they do a taught skill.
const SPOT_ME = /\b(?:spot me|spotter|keep an eye on me|watch over me|look over my shoulder|check my work|supervise me|watch me work)\b/i;

// Walkthroughs only ever follow a skill it has been taught. If none matches,
// say so (or fall back to `otherwise`) rather than improvising a procedure.
// opts.spot: Spotter mode (watch quietly, flag only what matters).
async function startGuide(text, scan, otherwise = null, screen = scan, opts = {}) {
  const notLearned = otherwise || {
    ok: false,
    reason: 'not-learned',
    say: "I haven't learned that yet.",
  };
  let found;
  try {
    found = await matchSkill(text, screen);
  } catch (err) {
    console.error('[guide] skill lookup', err.message);
    return { ok: false, reason: 'guide', say: "I couldn't check that just now." };
  }
  if (!found || !found.id) return notLearned;
  if (found.match === 'maybe') {
    // Close, but not certain: check before walking them through the wrong thing.
    pendingClarify = { id: found.id, text, at: Date.now(), agent: 'friday', spot: Boolean(opts.spot) };
    return { ok: true, clarify: true, question: found.question };
  }
  return beginSkill(found.id, text, opts);
}

// Which learned skill (if any) a request is for. Only asks Claude when the
// request shares a real word with something it has learned.
// `scan` (if known) says what's on screen, so a vague request ("export this")
// goes to the skill that fits where they are.
async function matchSkill(text, scan = null) {
  const skills = learnedSkills().filter((sk) => sharesWords(text, `${sk.title} ${sk.summary}`));
  if (!skills.length) return null;
  const found = await findSkill(cfg.anthropicApiKey, text, skills, [scan ? screenContext(scan) : '', turnHistory ? `\nRecent conversation:\n${turnHistory}` : ''].join(''));
  console.log(`[skills] "${text}" → ${found.id || 'none'} (${found.match})`);
  return found;
}

// After a clarifying question: yes starts the skill, no says so, anything else is a new request.
let pendingClarify = null;
ipcMain.handle('confirm', async (_e, rawText) => {
  sessionLog.convo('You', rawText, '[answering]');
  turnHistory = convo.forPrompt();
  convo.add('user', rawText);
  const res = await confirmReply(rawText);
  remember(rawText, res);
  sessionLog.convoFromReply(res, agent);
  return res;
});
async function confirmReply(rawText) {
  try {
    const text = stripWake(rawText);
    const pending = pendingClarify && Date.now() - pendingClarify.at < 60000 ? pendingClarify : null;
    pendingClarify = null;
    const again = () => (agent === 'jarvis' ? askJarvis(text) : ask(text));
    if (!pending) return again();
    const t = text.toLowerCase();
    const no = /^(no|nope|nah|not really|not quite|wrong|neither)\b[\s,.!-]*/.exec(t);
    if (no) {
      // "No, just get the application running": the rest is the real request.
      const rest = text.slice(no[0].length).replace(/^just\s+/i, '').trim();
      if (/[a-z]{3}/i.test(rest)) return agent === 'jarvis' ? askJarvis(rest) : ask(rest);
      if (pending.agent === 'jarvis' && Guide.available(cfg)) return beginFreestyle(pending.text);
      return { ok: false, reason: 'not-learned', say: pending.agent === 'jarvis' ? persona('jarvis', cfg).s("Then I'm afraid I haven't been taught that one{sir}.") : "Sorry, I can't do that one yet." };
    }
    if (/^(yes|yeah|yep|yup|sure|correct|right|exactly|that'?s (it|right)|it is|i do|please|ok(ay)?)\b/.test(t)) {
      return pending.agent === 'jarvis' ? beginJarvis(pending.id) : beginSkill(pending.id, pending.text, { spot: pending.spot });
    }
    return again();
  } catch (err) {
    console.error('[confirm]', err);
    return { ok: false, reason: 'error', say: 'Something went wrong. Try again.' };
  }
}

async function beginSkill(id, text, { spot = false } = {}) {
  let skill = loadSkill(id);
  if (!skill) return { ok: false, reason: 'not-learned', say: "I haven't learned that yet." };
  skill = await ensureRefined(id, skill);

  let plan = null;
  try {
    if (!readJson(path.join(skillDir(id), 'replay.json'))) win.webContents.send('say', { text: 'Getting that lesson ready…', speak: false });
    plan = await replayPlan(id, skill);
  } catch (err) {
    console.error('[guide] replay plan', err.message); // fall back to the raw recording
  }

  // A lesson, not a script: the replay moves on instantly while they're on
  // track; the tutor (Claude) steps in when they go off it, go quiet, or talk.
  const r = new Lesson({
    skill,
    plan,
    scan: scanFrontWindow,
    tutor: new Tutor(cfg.anthropicApiKey, skill),
    snap,
    spot,
    emit: (step) => {
      if (replay !== r) return;
      console.log(`[${spot ? 'spotter' : 'lesson'}] step ${step.stepNumber || '-'}/${step.totalSteps}${step.chat ? ' (tutor)' : ''}:`, step.status, step.target ? step.target.label : '', step.say ? `- ${step.say}` : '');
      win.webContents.send('guide-step', stepPayload(step));
      if (step.status !== 'step') stopGuide();
    },
    thinking: () => win.webContents.send('guide-thinking'),
  });
  replay = r;
  startInputHook();

  // Say every line once in the background so the voice is instant when needed
  // (not when spotting: it doesn't say the steps).
  if (!spot && cfg.elevenLabs.apiKey && cfg.voiceEnabled) {
    (async () => {
      for (const line of r.lines()) await voice.synthesize(line, cfg, 'happy').catch(() => {});
    })();
  }
  // Let the renderer switch into guide mode before the first step arrives.
  setTimeout(() => r.start(), 150);
  return { ok: true, guide: true, spot, status: 'starting', say: '', title: skill.map.title };
}

function stopGuide() {
  if (improv) {
    improv.stop();
    improv = null;
  }
  if (!replay) {
    if (!teach && !jarvisRun) stopInputHook();
    return;
  }
  replay.stop();
  replay = null;
  if (!teach && !jarvisRun) stopInputHook();
}

// The Done button: they've done this step (a decision is checked first).
ipcMain.on('guide-next', () => {
  if (replay) replay.done();
  if (improv) improv.skip();
});
// Said or typed during a lesson: part of the conversation, no "Hey Friday" needed.
ipcMain.on('guide-say', (_e, text) => guideSay(text));
function guideSay(text) {
  const t = tidySpeech(String(text || ''));
  if (!t) return false;
  sessionLog.convo('You', t, '[during the lesson]');
  if (replay) replay.onUserSays(t);
  else if (improv) improv.onUserSays(t);
  else return false;
  return true;
}

// ---------- best effort: tasks nobody has taught yet ----------
//
// Friday still helps with things she wasn't taught (opening an app, searching
// a site, changing a common setting), pointing at each step with Claude's
// general knowledge. She says so up front, and stops to say it needs teaching
// the moment she isn't confident, at the start or halfway through.

let improv = null; // ImprovisedWalkthrough
let lastUnlearned = ''; // the last thing they couldn't do: "let me show you" teaches it

function startImprovGuide(goal) {
  const brain = new Improviser(cfg.anthropicApiKey, { mode: 'guide' });
  const w = new ImprovisedWalkthrough({
    goal,
    history: turnHistory,
    brain,
    scan: scanFrontWindow,
    snap,
    fingerprint: screenFingerprint,
    ask: (text) => askUser(text, 'live'),
    thinking: () => win && win.webContents.send('guide-thinking'),
    emit: (step) => {
      if (improv !== w || !win) return;
      console.log(`[improvise] ${step.status} ${step.stepNumber}:`, step.target ? step.target.label : '', step.say);
      if (step.status === 'stuck') lastUnlearned = goal;
      win.webContents.send('guide-step', stepPayload({ ...step, totalSteps: 0 }));
      if (step.status !== 'step') stopGuide();
    },
  });
  improv = w;
  startInputHook();
  setTimeout(() => w.start(), 150);
  console.log(`[improvise] Friday has a go at "${goal}"`);
  return { ok: true, guide: true, status: 'starting', say: '', title: '' };
}
ipcMain.on('guide-stop', () => stopGuide());

// ---------- Jarvis: does learned tasks for you ----------
//
// Friday teaches a skill; Jarvis carries it out on your screen (src/jarvis.js),
// asking only for what's specific to this case and for a yes before anything
// risky. He can also open files and press a button you name.

let jarvisRun = null; // { run, id }
let passThrough = 0; // >0 while Jarvis's own clicks are in flight

// While Jarvis clicks, the overlay lets every click through, even over the bubble.
async function withPassThrough(fn) {
  passThrough++;
  overlayInteractive = false;
  if (win) win.setIgnoreMouseEvents(true, { forward: true });
  try {
    return await fn();
  } finally {
    setTimeout(() => passThrough--, 250);
  }
}

// Jarvis's hands. Keys go to the app you're working in, never to the overlay.
const hands = {
  click: (rect) => withPassThrough(() => act.click(rect)),
  type: (text) => act.type(text),
  keys: async (spec) => {
    await refocusFrontApp();
    return act.keys(spec);
  },
  selectAll: async () => {
    await refocusFrontApp();
    return act.selectAll();
  },
  escape: () => act.escape(),
  scroll: (point, lines) => withPassThrough(() => act.scroll(point, lines)),
  // Only web addresses, opened in the default browser.
  openUrl: async (url) => {
    const safe = cleanUrl(url);
    if (!safe) throw new Error(`not a web address: ${url}`);
    await shell.openExternal(safe);
    console.log(`[jarvis] opened ${safe}`);
  },
  // A file's text or a folder's contents, for following a README. Home folder
  // only, nothing hidden or secret-looking (src/files.js).
  readFile: async (query) => {
    const file = await resolveFile(query);
    if (!file) return { ok: false, why: 'not found' };
    const got = readTextFile(file);
    console.log(`[jarvis] read ${file}${got.ok ? '' : ` (refused: ${got.why})`}`);
    return got;
  },
  // Best matching file, opened with its usual app (no questions: he's mid-task).
  openFile: async (query) => {
    const [f] = await findFiles(query, { limit: 1 });
    if (!f || f.blocked) return null;
    const err = await shell.openPath(f.path);
    console.log(`[jarvis] opened ${f.path}${err ? ` (failed: ${err})` : ''}`);
    return err ? null : f.name;
  },
  // Best matching open window or tab, brought to the front.
  switchTo: async (query) => {
    const [best] = windows.rankOpen(query, await windows.listOpen());
    if (!best || best.score < 0.6) return null;
    await windows.bringToFront(best.item);
    return windows.describe(best.item);
  },
  // A command already checked and agreed (src/jarvis.js, src/runproject.js):
  // run in a visible Terminal window, its output copied to a log he reads back.
  runCommand: async ({ dir, command }) => {
    const logDir = path.join(app.getPath('userData'), 'jarvis-runs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, `command-${Date.now()}.log`);
    fs.writeFileSync(log, '');
    if (textMode.dryRun()) {
      console.log(`[dry] run in ${dir}: ${command}`);
      return { ok: true, finished: false, output: '(dry run: not actually run)', urls: [] };
    }
    const script = log.replace(/\.log$/, '.command');
    fs.writeFileSync(script, runProject.commandFile(dir, command, log), { mode: 0o700 });
    const err = await new Promise((resolve) => execFile('/usr/bin/open', ['-a', 'Terminal', script], (e) => resolve(e ? e.message : '')));
    if (err) return { ok: false, why: `Terminal wouldn't open (${err.split('\n')[0]})` };
    console.log(`[jarvis] running in ${dir}: ${command}`);
    // Wait for it to finish, print an address, or go quiet for a while.
    const started = Date.now();
    let output = '';
    let changedAt = started;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = fs.readFileSync(log, 'utf8');
      if (now !== output) {
        output = now;
        changedAt = Date.now();
      }
      if (runProject.exitCode(output) != null) break;
      if (runProject.findUrls(output).length && Date.now() - changedAt > 1500) break;
      if (Date.now() - changedAt > 8000 && output) break;
      if (Date.now() - started > 60000) break;
    }
    const code = runProject.exitCode(output);
    let servers = [];
    try {
      servers = runProject.listeningServers();
    } catch {}
    return { ok: true, finished: code != null, code, output: output.replace(/\x1b\[[0-9;]*m/g, '').slice(-3000), urls: runProject.findUrls(output), servers };
  },
  serversIn: async (dir) => {
    try {
      return runProject.serversIn(dir);
    } catch {
      return [];
    }
  },
  // Only apps installed in the Applications folders.
  openApp: async (name) => {
    const file = `${path.basename(String(name)).replace(/\.app$/i, '')}.app`;
    const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities', path.join(app.getPath('home'), 'Applications')];
    const found = dirs.map((d) => path.join(d, file)).find((p) => fs.existsSync(p));
    if (!found) return false;
    const err = await shell.openPath(found);
    console.log(`[jarvis] opened ${found}${err ? ` (failed: ${err})` : ''}`);
    return !err;
  },
};

const OPEN_RE = /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:open|launch|start|pull up|bring up|load)\s+(?:up\s+)?(.+?)(?:\s+for me)?(?:\s+please)?$/i;
const CLICK_RE = /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:click|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab))?(?:\s+for me)?(?:\s+please)?$/i;
// "open the File menu" is about the screen, not a file.
const UI_WORDS = /\b(menu|tab|button|settings|preferences|window|panel|sidebar|dialog|dropdown|toolbar)\b/i;
// Words that say "a file": an extension, or file-ish nouns.
const FILEISH = /\.\w{1,5}\b|\b(file|folder|document|doc|readme|pdf|spreadsheet|sheet|deck|slides|presentation|screenshot|photo|image|video|notes?)\b/i;
// "…and then run it", "…and use it to…": a second job after the first.
const MORE_TO_DO = /\b(and then|then (?:use|run|put|start|get|do|make|send|fill|type|click|copy)|after that|and (?:use|run|put|start|get|make|send|fill|type|copy|follow|install|set)\b)/i;
// "Open this in Preview", "show this in Finder", "where is this saved".
const THIS_FILE_RE = /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(open|show|reveal|find|where(?:'s| is))\s+(?:this|it|that)(?:\s+(?:file|document|doc|one|pdf|image|picture|photo))?(?:\s+(?:saved|stored|kept))?(?:\s+(?:in|with|using)\s+([\w .-]+?))?(?:\s+for me)?(?:\s+please)?[?.!]?$/i;
const LEARN_RE = /^(how (do|can|would|should) i|show me how|teach me|walk me through|guide me)\b/i;
// "Switch to the budget spreadsheet": an open window or tab, brought to the front.
const SWITCH_RE = /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:switch(?: back)? to|go(?: back)? to|bring (?:up|back)|focus(?: on)?|jump to|take me to|show me|get me|pull up|flip to|change to)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:window|tab))?(?:\s+for me)?(?:\s+please)?$/i;
// "Where's my passport scan": find the file and show it in Finder.
const FIND_RE = /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:find|locate|where(?:'s| is| are)|where did i (?:put|save)|show me where)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:is|are))?(?:\s+for me)?(?:\s+please)?$/i;

// The basics need no lesson: websites, web searches, typing and key presses.
const URL_RE = /^(?:please\s+)?(?:go to|open|visit|pull up|bring up|navigate to|load)\s+((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)(?:\s+please)?$/i;
const SEARCH_RE = /^(?:please\s+)?(?:search(?:\s+the\s+web|\s+google|\s+online)?(?:\s+for|\s+up)?|google|look up)\s+(.+?)(?:\s+for me)?(?:\s+please)?$/i;
const TYPE_RE = /^(?:please\s+)?type\s+(?:out\s+)?(.+)$/i;
const PRESS_RE = /^(?:please\s+)?(?:press|hit)\s+(.+?)(?:\s+for me)?$/i;

async function jarvisBasics(text, p) {
  const url = URL_RE.exec(text);
  if (url) {
    await hands.openUrl(url[1]);
    return { ok: true, sayOnly: true, say: p.s(`Opening ${url[1].replace(/^https?:\/\//, '').replace(/\/$/, '')}{sir}.`) };
  }
  const search = SEARCH_RE.exec(text);
  // "Search for shoes on Amazon" is a task on a site: that's for the best-effort path.
  if (search && !/\s(on|in)\s+\S+$/i.test(search[1])) {
    const q = search[1].replace(/^["']|["']$/g, '');
    await hands.openUrl(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
    return { ok: true, sayOnly: true, say: p.s(`Searching for ${q}{sir}.`) };
  }
  const type = TYPE_RE.exec(text);
  if (type) {
    const t = type[1].replace(/^["'“]|["'”]$/g, '');
    await refocusFrontApp();
    await act.type(t);
    console.log(`[jarvis] typed ${JSON.stringify(t)}`);
    return { ok: true, sayOnly: true, say: p.s('Done{sir}.') };
  }
  const press = PRESS_RE.exec(text);
  const keys = press && act.spokenShortcut(press[1]);
  if (keys) {
    if (riskOf({ kind: 'shortcut', keys }) && !isYes(await askUser(p.s(`That would press ${press[1]}. Shall I go ahead{sir}?`), 'jarvis-confirm'))) {
      return { ok: true, sayOnly: true, say: p.s('Very good. I shall leave it.') };
    }
    await hands.keys(act.parseShortcut(keys));
    console.log(`[jarvis] pressed ${keys}`);
    return { ok: true, sayOnly: true, say: p.s('Done{sir}.') };
  }
  return null;
}

// Speech comes with "um"s and commas ("can you, um, find…"): drop them so the
// request reads the way it was meant.
function tidySpeech(text) {
  return String(text || '')
    // A false start: "Find-- open the README" means "open the README".
    .replace(/^\s*[\w']+(?:\s+[\w']+)?\s*(?:--|—|–)\s*/, '')
    .replace(/\b(um+|uh+|erm|er|hmm+|like)\b,?/gi, ' ')
    .replace(/(\w),(\s)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

async function askJarvis(raw) {
  const text = tidySpeech(raw);
  const p = persona('jarvis', cfg);
  if (teach) return { ok: false, reason: 'busy', say: p.s("Friday is in the middle of a lesson{sir}. I'll wait until she's finished.") };
  stopGuide();
  stopJarvis('new-request');

  // "How do I…" is a request to learn, which is Friday's department.
  if (LEARN_RE.test(text)) {
    setAgent('friday');
    return ask(text);
  }

  // Carrying on with what he just did here ("and that one?" after pointing at
  // something in a screenshot): do the same kind of thing.
  const follow = Guide.available(cfg) ? convo.followUp(text, lastScreenKey) : null;
  if (follow === 'look' || follow === 'answer') {
    console.log(`[jarvis] follow-up to the last ${follow}`);
    const { scan: seen } = await scanForAsk();
    const res = seen ? (follow === 'look' ? await visualAnswer(text, seen, 'jarvis', 'a follow-up to what was just looked at') : await screenAnswer(text, seen, 'jarvis')) : null;
    if (res) return res;
  }

  try {
    const basic = await jarvisBasics(text, p);
    if (basic) return basic;
  } catch (err) {
    console.error('[jarvis] basics', err.message);
    return { ok: false, reason: 'error', say: p.s("I'm afraid macOS wouldn't let me do that{sir}. Check Accessibility and Automation in Privacy and Security.") };
  }

  // "Open this in Preview", "where's this saved?": this = the file the front window has open.
  const thisFile = THIS_FILE_RE.exec(text);
  if (thisFile) {
    const res = await thisFileRequest(thisFile, p);
    if (res) return res;
  }

  // Quick routes are for one thing ("open the README"). "Read the README and
  // then run it" is a task with more to it: that's for the best-effort path.
  const moreToDo = MORE_TO_DO.test(text);
  // Something already open beats opening it again.
  const find = !moreToDo && FIND_RE.exec(text);
  const sw = !moreToDo && !find && SWITCH_RE.exec(text);
  const open = !moreToDo && !find && !sw && OPEN_RE.exec(text);
  // "Find the window I had the meeting open in" is about what's open, not files.
  if (find && /\b(window|tab|had\b.*\bopen|was\b.*\bopen|meeting|call)\b/i.test(find[1])) {
    const res = await switchToWindow(find[1], p, { eager: true });
    if (res) return res;
  }
  if (sw || open) {
    const res = await switchToWindow((sw || open)[1], p, { eager: Boolean(sw) });
    if (res) return res;
  }
  if ((open || sw) && !UI_WORDS.test((open || sw)[1])) {
    const res = await openFileRequest((open || sw)[1], p);
    if (res) return res;
  }
  if (find && !UI_WORDS.test(find[1])) {
    // "Find the README and open it" opens it; plain "find…" shows it in Finder.
    const res = await openFileRequest(find[1], p, { reveal: !/\band open\b/i.test(find[1]) });
    if (res) return res;
  }
  // "Could you please just open the README.md for PianoScribe": a file asked
  // for mid-sentence still takes the quick route, no Claude needed.
  const late = !moreToDo && !find && !sw && !open && /\b(open|pull up|bring up)\s+(?:up\s+)?(.+)$/i.exec(text);
  if (late && FILEISH.test(late[2]) && !UI_WORDS.test(late[2])) {
    const res = await openFileRequest(late[2].replace(/\s+(?:for me|please)$/i, ''), p);
    if (res) return res;
  }

  // The skill lookup (Claude) and the screen scan don't depend on each other: do both at once.
  const looking = scanForAsk();
  // "What does this do?": answered from what's on screen.
  if (Guide.available(cfg) && !moreToDo) {
    const { scan: seen } = await looking;
    // Questions and "show me" look at the screen (always mode); a picture, a
    // diagram, an app that describes nothing gets a look either way.
    const asking = isScreenQuestion(text) || SHOW_ME.test(text);
    const looked = !seen ? null : alwaysLook() && asking ? await visualAnswer(text, seen, 'jarvis', 'every question is looked at') : await lookIfNeeded(text, seen, 'jarvis');
    if (looked) return looked;
    if (isScreenQuestion(text)) {
      const res = seen ? await screenAnswer(text, seen, 'jarvis') : null;
      if (res) return res;
    }
  }
  let relatedSkill = null;
  if (Guide.available(cfg)) {
    let found = null;
    try {
      found = await matchSkill(text, (await looking).scan);
    } catch (err) {
      console.error('[jarvis] skill lookup', err.message);
    }
    // A clear match runs the learned skill. A "maybe" isn't worth a question:
    // he does what was actually asked, with that skill as an expert's reference.
    if (found && found.id && found.match !== 'maybe') return beginJarvis(found.id);
    if (found && found.id && found.match === 'maybe') relatedSkill = loadSkill(found.id);
  }

  const { scan, reply } = await looking;
  if (reply) return { ...reply, say: p.s(`${reply.say.replace(/\.$/, '')}{sir}.`) };
  const clickable = scan.elements.filter((e) => CLICKABLE_ROLES.has(e.role) && !e.hidden);

  // "Click Share": he presses it himself.
  const click = CLICK_RE.exec(text);
  if (click) {
    const result = findBest(click[1], clickable);
    if (!result.match || result.score < 0.8) return { ok: false, reason: 'not-found', say: p.s(`I'm afraid I can't see "${click[1]}"{sir}.`) };
    return jarvisClick(result.match, p);
  }

  // A short name of something on screen ("share", "the save button"): point at it.
  const result = findBest(text, scan.elements);
  if (result.match && !result.match.hidden && result.score >= 0.9 && text.split(/\s+/).length <= 4) {
    const m = result.match;
    return { ok: true, label: m.label, role: ROLE_NAMES[m.role] || 'thing', app: m.app || scan.app, rect: toLocal(m), say: p.s(`The ${m.label} ${ROLE_NAMES[m.role] || ''} is just there{sir}.`).replace(/ {2,}/g, ' ') };
  }

  // "Where's the database in this diagram?": not something accessibility describes. Look.
  if (Guide.available(cfg) && !moreToDo && LOOKABLE.test(text) && !(result.match && result.score >= 0.9)) {
    const looked = await lookIfNeeded(text, scan, 'jarvis', { missed: true });
    if (looked) return looked;
  }

  // Not taught: he has a go, and says honestly if he can't do it properly.
  if (Guide.available(cfg)) return beginFreestyle(text, relatedSkill);
  return { ok: false, reason: 'not-learned', say: p.s("I'm afraid I haven't been taught that one{sir}. Friday can learn it from someone who knows how.") };
}

function beginFreestyle(goal, related = null) {
  const p = persona('jarvis', cfg);
  if (related) console.log(`[jarvis] with "${related.map.title}" as reference`);
  const run = new JarvisFreestyle({
    goal,
    history: turnHistory,
    snap,
    related,
    improviser: new Improviser(cfg.anthropicApiKey, { mode: 'do', address: cfg.jarvis.address }),
    s: p.s,
    scan: scanFrontWindow,
    act: hands,
    ask: askUser,
    emit: jarvisEmitter(() => run),
  });
  console.log(`[jarvis] having a go at "${goal}"`);
  return launchJarvis(run, { title: goal, id: null });
}

// Steps, speech and where he's about to click, for the orb.
function jarvisEmitter(getRun) {
  return (ev) => {
    if (!jarvisRun || jarvisRun.run !== getRun() || !win) return;
    if (ev.type === 'point') win.webContents.send('jarvis-step', { rect: toLocal(ev.target), label: ev.target.label });
    else win.webContents.send('jarvis-step', { say: ev.say || '', stepNo: ev.stepNo || 0, totalSteps: ev.totalSteps || 0, quiet: Boolean(ev.quiet) });
  };
}

// Press one named button, with a yes first if it looks risky.
async function jarvisClick(el, p) {
  if (riskOf({ kind: 'click', label: el.label })) {
    const answer = await askUser(p.s(`That will press "${el.label}". Shall I go ahead{sir}?`), 'jarvis-confirm');
    if (!isYes(answer)) return { ok: true, sayOnly: true, say: p.s('Very good. I shall leave it.') };
  }
  win.webContents.send('jarvis-step', { rect: toLocal(el), label: el.label });
  await new Promise((r) => setTimeout(r, 900)); // let the cursor arrive so you can see what he's pressing
  try {
    await hands.click(el);
  } catch (err) {
    console.error('[jarvis] click', err.message);
    return { ok: false, reason: 'error', say: p.s("I'm afraid macOS wouldn't let me click that{sir}. Check Accessibility in Privacy and Security.") };
  }
  console.log(`[jarvis] clicked ${el.role} "${el.label}"`);
  return { ok: true, sayOnly: true, home: true, say: p.s(`Done{sir}.`) };
}

// "Which one: 1, …; 2, …?" -> the chosen item, or null.
async function pickOne(items, label, p, question) {
  const answer = await askUser(p.s(`${question} ${items.map((x, i) => `${i + 1}, ${label(x)}`).join('; ')}. Which one{sir}?`), 'jarvis-input');
  if (!answer) return null;
  const n = { one: 1, first: 1, '1': 1, two: 2, second: 2, '2': 2, three: 3, third: 3, '3': 3 }[(/\b(one|two|three|first|second|third|[123])\b/i.exec(answer) || [])[1]?.toLowerCase()];
  if (n) return items[n - 1] || null;
  const best = findBest(answer, items.map((x, i) => ({ label: label(x), role: 'AXButton', i })));
  return best.match ? items[best.match.i] : null;
}

// "Switch to the budget spreadsheet": bring an open window or browser tab to the
// front. Returns null when nothing open matches well enough, so the request can
// be tried as a file. `eager` (an explicit "switch to") accepts looser matches.
async function switchToWindow(what, p, { eager = false } = {}) {
  let open;
  try {
    open = await windows.listOpen();
  } catch (err) {
    console.error('[jarvis] windows', err.message);
    return null;
  }
  const ranked = windows.rankOpen(what, open);
  const bar = eager ? 0.6 : 0.85;
  const good = ranked.filter((x) => x.score >= bar);
  console.log(`[jarvis] switch "${what}" →`, ranked.slice(0, 3).map((x) => `${windows.describe(x.item)} (${x.score.toFixed(2)})`).join(', ') || 'no name matches');
  let choices = good.length ? good.filter((x) => x.score >= good[0].score - 0.05).slice(0, 3).map((x) => x.item) : [];

  // Described rather than named ("the window I had the meeting in"): Claude reads what's open.
  const described = eager || /\b(had|was|were|where|with|from|about)\b/i.test(what);
  if (!choices.length && described && Guide.available(cfg)) {
    try {
      const r = await windows.pickWithClaude(cfg.anthropicApiKey, what, open);
      console.log(`[jarvis] switch "${what}" (Claude) → ${r.match}:`, r.items.map(windows.describe).join(', '));
      choices = r.items;
    } catch (err) {
      console.error('[jarvis] window pick', err.message);
    }
  }
  if (!choices.length) return null;
  let pick = choices[0];
  if (choices.length > 1) {
    pick = await pickOne(choices, windows.describe, p, `${choices.length} of those are open:`);
    if (!pick) return { ok: true, sayOnly: true, say: p.s('Very good. Standing by.') };
  }
  try {
    await windows.bringToFront(pick);
  } catch (err) {
    console.error('[jarvis] switch', err.message);
    return { ok: false, reason: 'error', say: p.s(`I couldn't bring ${windows.describe(pick)} forward{sir}.`) };
  }
  console.log(`[jarvis] brought forward: ${windows.describe(pick)}`);
  return { ok: true, sayOnly: true, say: p.s(`${windows.describe(pick)[0].toUpperCase()}${windows.describe(pick).slice(1)}{sir}.`) };
}

// Where a file lives, said out loud: "in Documents", "in Projects inside Documents".
function whereIs(file) {
  const home = app.getPath('home');
  const rel = path.relative(home, path.dirname(file));
  if (!rel) return 'in your home folder';
  const parts = rel.split(path.sep).filter((x) => x !== 'Library' && x !== 'Mobile Documents' && x !== 'com~apple~CloudDocs');
  if (!parts.length) return 'in iCloud Drive';
  return parts.length === 1 ? `in ${parts[0]}` : `in ${parts[parts.length - 1]}, inside ${parts[0]}`;
}

// "Open the Q3 report": find it with Spotlight and open it in its usual app (or
// the one named: "…in Preview"). With reveal, show it in Finder instead.
// Returns null if nothing matches, so the request can be tried as something else.
async function openFileRequest(what, p, { reveal = false } = {}) {
  let found;
  const started = Date.now();
  try {
    found = await findFiles(what, { rephrase: Guide.available(cfg) ? makeRephrase(cfg.anthropicApiKey) : null });
  } catch (err) {
    console.error('[jarvis] file search', err.message);
    return null;
  }
  console.log(`[jarvis] ${reveal ? 'find' : 'open'} "${what}" (${Date.now() - started} ms) →`, found.map((f) => `${f.name} (${f.score.toFixed(2)}${f.remembered ? ', remembered' : ''}${f.blocked ? `, ${f.blocked}` : ''})`).join(', ') || 'nothing');
  if (!found.length) return null;

  let pick = found[0];
  if (!isClear(found, what)) {
    const close = found.filter((f) => f.score >= found[0].score - 0.1).slice(0, 3);
    pick = await pickOne(close, (f) => `${f.name} ${whereIs(f.path)}`, p, `I found ${close.length} likely candidates:`);
    if (!pick) return { ok: true, sayOnly: true, say: p.s('Very good. Standing by.') };
    rememberPick(what, pick.path); // next time, straight there
  }

  if (pick.blocked) {
    const why = pick.blocked === 'app-outside-applications'
      ? `I'd rather not launch an app from outside your Applications folder{sir}. "${pick.name}" stays closed.`
      : `"${pick.name}" would run code on your Mac, so I'll leave that one to you{sir}.`;
    console.log(`[jarvis] refused to open ${pick.path} (${pick.blocked})`);
    return { ok: false, reason: 'blocked', say: p.s(why) };
  }
  const nice = pick.name.replace(/\.[^.]+$/, '');
  if (reveal) {
    shell.showItemInFolder(pick.path);
    console.log(`[jarvis] showed ${pick.path}`);
    return { ok: true, sayOnly: true, say: p.s(`${nice} is ${whereIs(pick.path)}{sir}. I've shown it to you in Finder.`) };
  }
  // "…in Preview": only apps from the Applications folders.
  const withApp = parseQuery(what).withApp;
  const appPath = withApp && appRoots(app.getPath('home')).map((d) => path.join(d, `${path.basename(withApp)}.app`)).find((x) => fs.existsSync(x));
  const err = appPath
    ? await new Promise((resolve) => execFile('/usr/bin/open', ['-a', appPath, pick.path], (e) => resolve(e ? e.message : '')))
    : await shell.openPath(pick.path);
  if (err) {
    console.error('[jarvis] open', pick.path, err);
    return { ok: false, reason: 'error', say: p.s(`I couldn't open "${pick.name}"{sir}.`) };
  }
  console.log(`[jarvis] opened ${pick.path}${appPath ? ` in ${appPath}` : ''}`);
  return { ok: true, sayOnly: true, say: p.s(`Opening ${nice}${appPath ? ` in ${withApp}` : ''}{sir}.`) };
}

// "This file" is whatever the front window has open (macOS tells us its path).
async function thisFileRequest(m, p) {
  let scan;
  try {
    scan = await scanFrontWindow();
  } catch {
    return null;
  }
  const doc = scan && scan.document;
  if (!doc || !fs.existsSync(doc)) return null; // nothing open as a file: try it as something else
  const name = path.basename(doc).replace(/\.[^.]+$/, '');
  const verb = m[1].toLowerCase();
  if (verb !== 'open' || /finder/i.test(m[2] || '')) {
    shell.showItemInFolder(doc);
    return { ok: true, sayOnly: true, say: p.s(`${name} is ${whereIs(doc)}{sir}. I've shown it to you in Finder.`) };
  }
  const withApp = m[2] && m[2].trim();
  const appPath = withApp && appRoots(app.getPath('home')).map((d) => path.join(d, `${path.basename(withApp).replace(/\b\w/g, (c) => c.toUpperCase())}.app`)).find((x) => fs.existsSync(x));
  if (withApp && !appPath) return { ok: false, reason: 'not-found', say: p.s(`I can't find ${withApp} in your Applications{sir}.`) };
  const err = appPath
    ? await new Promise((resolve) => execFile('/usr/bin/open', ['-a', appPath, doc], (e) => resolve(e ? e.message : '')))
    : await shell.openPath(doc);
  if (err) return { ok: false, reason: 'error', say: p.s(`I couldn't open ${name}{sir}.`) };
  console.log(`[jarvis] opened the front document ${doc}${appPath ? ` in ${appPath}` : ''}`);
  return { ok: true, sayOnly: true, say: p.s(`Opening ${name}${appPath ? ` in ${withApp}` : ''}{sir}.`) };
}

// Jarvis's plan for a skill (which values to ask for, what to confirm), made once.
async function jarvisPlan(id, skill, actions) {
  const file = path.join(skillDir(id), 'jarvis.json');
  const key = `${actions.length}|${cfg.jarvis.address}`;
  const saved = readJson(file);
  if (saved && saved.key === key) return saved.plan;
  const plan = await planRun(cfg.anthropicApiKey, skill, actions, cfg.jarvis.address);
  fs.writeFileSync(file, JSON.stringify({ key, plan }, null, 2));
  console.log(`[jarvis] plan for "${skill.map.title}": ${plan.inputs.length} questions, can_run=${plan.can_run}`);
  return plan;
}

async function beginJarvis(id) {
  const p = persona('jarvis', cfg);
  let skill = loadSkill(id);
  if (!skill) return { ok: false, reason: 'not-learned', say: p.s("I'm afraid I haven't been taught that one{sir}.") };
  skill = await ensureRefined(id, skill);

  let recorded = null;
  try {
    recorded = await replayPlan(id, skill);
  } catch (err) {
    console.error('[jarvis] replay plan', err.message); // fall back to the raw recording
  }
  const actions = buildActions(skill, recorded);
  if (!actions.length) return { ok: false, reason: 'empty', say: p.s("There's nothing in that lesson I can actually do{sir}.") };

  let plan;
  try {
    plan = await jarvisPlan(id, skill, actions);
  } catch (err) {
    console.error('[jarvis] plan', err.message);
    return { ok: false, reason: 'guide', say: p.s("I couldn't prepare that one just now{sir}. Try again in a moment.") };
  }
  if (!plan.can_run) return { ok: false, reason: 'declined', say: plan.why_not || p.s("I'm afraid that one needs a human touch{sir}.") };

  const run = new JarvisRun({ skill, actions, plan, s: p.s, scan: scanFrontWindow, act: hands, ask: askUser, emit: jarvisEmitter(() => run) });
  console.log(`[jarvis] starting "${skill.map.title}" (${actions.length} actions)`);
  return launchJarvis(run, { title: skill.map.title, id });
}

// Start a run (learned or best effort) and clean up after it, whatever happens.
function launchJarvis(run, { title, id }) {
  jarvisRun = { run, id };
  startInputHook();
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (win) win.webContents.send('jarvis-state', { running: true, title, totalSteps: run.total });

  // Let the renderer switch into Jarvis mode before the first question arrives.
  setTimeout(async () => {
    const result = await run.run();
    console.log(`[jarvis] "${title}" ended: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    if (result.error && result.reason === 'ACCESSIBILITY') systemPreferences.isTrustedAccessibilityClient(true);
    if (result.status === 'needs_teaching') lastUnlearned = title;
    saveRunLog(id, run, result);
    if (jarvisRun && jarvisRun.run === run) jarvisRun = null;
    // A newer run may have taken over (a new request stops the old one): leave it be.
    if (jarvisRun) return;
    cancelQuestions();
    if (!replay && !teach) stopInputHook();
    if (tray) tray.setContextMenu(buildTrayMenu());
    if (win) win.webContents.send('jarvis-state', { running: false, status: result.status, say: result.say });
  }, 200);
  return { ok: true, jarvis: true, title, totalSteps: run.total };
}

function stopJarvis(reason = 'stopped') {
  if (!jarvisRun) return;
  jarvisRun.run.stop(reason);
  cancelQuestions();
}

// Every run is written down next to the skill: what he asked, what he did, how it ended.
function saveRunLog(id, run, result) {
  try {
    // Best-effort runs (no skill) are kept together in one folder.
    const dir = id ? path.join(skillDir(id), 'runs') : path.join(app.getPath('userData'), 'jarvis-runs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(run.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ skill: run.skill.map.title, startedAt: run.startedAt, status: result.status, reason: result.reason || '', log: run.log }, null, 2));
  } catch (err) {
    console.error('[jarvis] log', err.message);
  }
}

ipcMain.on('jarvis-stop', () => stopJarvis('user'));
ipcMain.on('set-agent', (_e, id) => setAgent(id));

// ---------- teaching sessions (the apprentice watches an expert) ----------

let teach = null; // { session, dir }
const answerWaiters = new Map();
let questionSeq = 0;

// Readable names for the keys we record as shortcuts (⌘S, ⌃⇧P…).
const KEY_NAMES = Object.fromEntries(Object.entries(UiohookKey).map(([name, code]) => [code, name]));

// Plain Return and Tab are basic computer use, not a "shortcut" in the usual
// sense, but they're exactly the keys an expert presses without a modifier
// that still matter (submitting a search, moving to the next field) -- so
// they're worth recording even though no ⌘/⌃ is held.
const BARE_KEYS = new Set(['Enter', 'NumpadEnter', 'Tab']);

function shortcutName(e) {
  const name = KEY_NAMES[e.keycode];
  if (!name) return null;
  if (!e.metaKey && !e.ctrlKey) return BARE_KEYS.has(name) ? (name === 'Tab' ? 'Tab' : 'Enter') : null;
  if (/^(Meta|Ctrl|Alt|Shift)/.test(name)) return null;
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
    if (improv) improv.onInput();
    // You clicking somewhere yourself while Jarvis works stops him.
    if (jarvisRun) jarvisRun.run.onUserClick();
  });
  uIOhook.on('keydown', (e) => {
    // Esc always stops Jarvis, wherever the keyboard is.
    if (jarvisRun && e.keycode === UiohookKey.Escape) jarvisRun.run.onEscape();
    if (overlayInteractive) return;
    const keys = shortcutName(e);
    if (teach) teach.session.onKey(keys);
    if (replay) replay.onKey(keys);
    if (improv) improv.onInput();
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
  if (typed) return typed.askUser(text, phase);
  const id = ++questionSeq;
  return new Promise((resolve) => {
    answerWaiters.set(id, resolve);
    // Answers are spoken, so the app you're working in keeps the keyboard.
    win.webContents.send('teach-question', { id, text, phase });
  });
}

ipcMain.on('teach-answer', (_e, { id, text }) => {
  sessionLog.convo('You', text || '', text && text.trim() ? '[answer]' : '[skipped the question]');
  const resolve = answerWaiters.get(id);
  if (!resolve) return;
  answerWaiters.delete(id);
  resolve((text || '').trim());
});

// Drop any open question (as if skipped) and close it on screen.
function cancelQuestions() {
  if (!answerWaiters.size) return;
  for (const resolve of answerWaiters.values()) resolve('');
  answerWaiters.clear();
  if (win) win.webContents.send('question-cancel');
}

function startTeach(title) {
  if (teach) return;
  // Lessons are Friday's department.
  setAgent('friday');
  stopJarvis('teach');
  if (!Guide.available(cfg)) {
    win.webContents.send('say', { text: 'I need an Anthropic API key to learn. Add ANTHROPIC_API_KEY to the .env file.', mood: 'worried' });
    return;
  }
  // "Let me show you" after a "needs teaching" teaches exactly that.
  const name = (title || '').trim() || lastUnlearned || 'Untitled task';
  lastUnlearned = '';
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
  if (!replay && !jarvisRun) stopInputHook();
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
    const tidied = (map.cleanup_notes || []).length ? ' I tidied it up so anyone can follow it from wherever they start.' : '';
    win.webContents.send('say', { text: `Got it. Your Work Map has ${map.steps.length} steps and ${judg} judgment calls.${tidied} I've opened it for you.`, mood: 'happy' });
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
  sessionLog.convo('You', text, '[explaining while teaching]');
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
      // Refresh presentation for existing recordings without changing their learned data.
      if (map && sess && Array.isArray(sess.events) && Array.isArray(sess.qas)) {
        try {
          const html = renderWorkMap({ map, session: sess });
          if (!fs.existsSync(page) || fs.readFileSync(page, 'utf8') !== html) fs.writeFileSync(page, html);
        } catch (err) { console.warn('[hub] Could not refresh training guide:', err.message); }
      }
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
        tidied: Boolean(map && map.refined),
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
    height: 780,
    minWidth: 820,
    minHeight: 520,
    title: 'Skills Hub',
    // A Mac app window: traffic lights inset over a translucent sidebar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'hub-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  hub.once('ready-to-show', () => hub.show());
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  hub.loadFile(path.join(__dirname, 'renderer', 'hub', 'hub.html'));
  if (selectId) hub.webContents.once('did-finish-load', () => hub.webContents.send('hub-changed', selectId));
  hub.on('closed', () => {
    hub = null;
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
}

ipcMain.handle('hub-list', () => listSkills());
// Everything the hub shows for one skill: its Work Map, and from the session
// only what the map refers to (events with their screen moments, the Q&A).
ipcMain.handle('hub-skill', (_e, id) => {
  const dir = skillDir(id);
  const map = dir && readJson(path.join(dir, 'workmap.json'));
  if (!map) return null;
  const sess = readJson(path.join(dir, 'session.json')) || { events: [], qas: [] };
  const frameUrl = (f) => {
    if (!f || !f.file) return null;
    const file = path.resolve(dir, f.file);
    return file.startsWith(dir + path.sep) && fs.existsSync(file) ? pathToFileURL(file).href : null;
  };
  return {
    id: path.basename(dir),
    map,
    startedAt: sess.startedAt || null,
    events: (sess.events || []).map((e) => ({ id: e.id, t: e.t, type: e.type, label: e.label, text: e.text, from: e.from, to: e.to, role: e.role, keys: e.keys, app: e.app, window: e.window, rect: e.rect, frame: e.frame ? { url: frameUrl(e.frame), display: e.frame.display } : null })),
    qas: sess.qas || [],
  };
});
// "Spot me": she watches while you do it, and only speaks up when something's off.
ipcMain.on('hub-spot', async (_e, id) => {
  if (teach) return;
  setAgent('friday');
  if (hub && !hub.isDestroyed()) hub.minimize();
  await refocusFrontApp();
  stopGuide();
  stopJarvis('new-request');
  const res = await beginSkill(path.basename(String(id)), '', { spot: true });
  if (win) win.webContents.send('show-result', res);
});
// "Teach me": Friday walks you through it on your own screen.
ipcMain.on('hub-learn', async (_e, id) => {
  if (teach) return;
  setAgent('friday');
  if (hub && !hub.isDestroyed()) hub.minimize();
  await refocusFrontApp();
  stopGuide();
  stopJarvis('new-request');
  const res = await beginSkill(path.basename(String(id)));
  if (win) win.webContents.send('show-result', res);
});
// "Export for agents": the steps and guardrails as instructions an agent can follow.
ipcMain.handle('hub-export', async (_e, id) => {
  const dir = skillDir(id);
  const map = dir && readJson(path.join(dir, 'workmap.json'));
  if (!map) return null;
  const KIND = { limit: 'Limit', exception: 'Exception', stop_and_ask: 'Stop and ask' };
  const lines = [`# ${map.title}`, '', map.summary || '', '', '## Steps', ''];
  map.steps.forEach((st, i) => {
    lines.push(`${i + 1}. **${st.title}**: ${st.action}`);
    if (st.is_judgment && st.decision) lines.push(`   - Decision: ${st.decision}`);
    if (st.reason) lines.push(`   - Why (the expert's words): "${st.reason}"`);
    if (st.rule) lines.push(`   - Rule: ${st.rule}`);
    for (const g of st.guardrails || []) lines.push(`   - ${KIND[g.kind] || g.kind}: ${g.text}`);
  });
  lines.push('', '## Always', '', '- Where a step says "Stop and ask", stop and ask a person before going on.', '- Never type passwords or codes.');
  const file = path.join(dir, 'agent-instructions.md');
  fs.writeFileSync(file, lines.join('\n'));
  shell.showItemInFolder(file);
  return file;
});
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
// "Have Jarvis do it": get the Skills Hub out of the way so he can see (and click) the app.
ipcMain.on('hub-run', async (_e, id) => {
  if (teach) return;
  setAgent('jarvis');
  if (hub && !hub.isDestroyed()) hub.minimize();
  await refocusFrontApp();
  stopGuide();
  stopJarvis('new-request');
  const res = await beginJarvis(path.basename(String(id)));
  if (!res.ok && win) win.webContents.send('say', { text: res.say, mood: 'worried' });
});
ipcMain.on('open-hub', () => openHub());

// Short phrases said while waiting, made ahead so they play instantly. The
// renderer gets the same lists (src/persona.js) with the config.
function prewarmVoice() {
  if (!cfg.elevenLabs.apiKey || !cfg.voiceEnabled) return;
  // Common lines are kept on disk, so after the first launch this costs nothing.
  voice.setDiskCache(path.join(app.getPath('userData'), 'voice-cache'));
  (async () => {
    for (const id of [agent, ...AGENTS.filter((a) => a !== agent)]) {
      const p = persona(id, cfg);
      for (const line of p.fillers) await voice.synthesize(line, cfg, '', id).catch(() => {});
      for (const line of p.acks) await voice.synthesize(line, cfg, 'happy', id).catch(() => {});
    }
  })();
}

ipcMain.handle('speak', async (_e, text) => {
  try {
    const buf = await voice.synthesize(text, cfg, 'happy', agent);
    return { audio: buf ? buf.toString('base64') : null };
  } catch (err) {
    console.error('[voice]', err.message);
    return { audio: null, error: err.message };
  }
});

ipcMain.on('set-interactive', (_e, interactive) => {
  if (!win) return;
  // While Jarvis is clicking, the overlay must never catch the mouse.
  if (interactive && passThrough) return;
  overlayInteractive = interactive;
  if (interactive) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on('open-prompt', () => openPrompt());
// Typing an answer: the overlay takes the keyboard until it's sent.
ipcMain.on('focus-overlay', () => focusOverlay());

ipcMain.on('prompt-closed', () => {
  if (!win) return;
  overlayInteractive = false;
  win.setIgnoreMouseEvents(true, { forward: true });
  refocusFrontApp(); // hand keyboard focus back to what you were using
});

function buildTrayMenu() {
  return Menu.buildFromTemplate([
      { label: `Ask ${persona(agent, cfg).name} (just talk)`, accelerator: ASK_SHORTCUT, click: () => listen('ask') },
      { type: 'separator' },
      { label: 'Friday: learns and teaches tasks', type: 'radio', checked: agent === 'friday', click: () => setAgent('friday', { announce: true }) },
      { label: 'Jarvis: does tasks for you', type: 'radio', checked: agent === 'jarvis', click: () => setAgent('jarvis', { announce: true }) },
      { label: 'Stop Jarvis (Esc)', enabled: Boolean(jarvisRun), click: () => stopJarvis('menu') },
      { type: 'separator' },
      { label: 'Teach me a task…', click: () => listen('teach-name') },
      {
        label: `Listen for "Hey ${cfg.wakeWord[0].toUpperCase()}${cfg.wakeWord.slice(1)}" / "Hey ${cfg.jarvis.wakeWord[0].toUpperCase()}${cfg.jarvis.wakeWord.slice(1)}"`,
        type: 'checkbox',
        checked: wakeOn(),
        enabled: Boolean(cfg.elevenLabs.apiKey),
        click: (item) => setWake(item.checked),
      },
      { label: 'Open Skills Hub', click: () => openHub() },
      {
        label: 'Look at the screen when needed (diagrams, pictures)',
        type: 'checkbox',
        checked: Boolean(visionAllowed()),
        enabled: Guide.available(cfg),
        click: (item) => {
          visionOn = item.checked;
          console.log(`[vision] ${item.checked ? 'on' : 'off'}`);
        },
      },
      { label: 'What can you see? (debug)', click: () => dumpScan() },
      { label: "Open this session's log", click: () => sessionLog.sessionLogPath() && shell.openPath(sessionLog.sessionLogPath()) },
      { label: 'Show all logs in Finder', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
      { label: 'Open Accessibility settings', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
      { label: 'Open folder for .env (API keys)', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: 'Quit Project Stark', role: 'quit' },
    ]);
}

// Everything the scan sees in the front app, as a text file, for "why can't it see X?".
async function dumpScan() {
  try {
    await refocusFrontApp();
    await new Promise((r) => setTimeout(r, 300));
    const s = await scanFrontWindow();
    if (s.error) throw new Error(s.message || s.error);
    const lines = [
      `${s.app} — "${s.window || ''}"   ${s.elements.length} items kept, ${s.visited} looked at, ${s.ms} ms${s.truncated ? '   STOPPED EARLY: deeper items were missed' : ''}`,
      s.focused ? `Typing in: ${s.focused.role} "${s.focused.label}"${s.focused.value ? ` = "${s.focused.value}"` : ''}` : 'Typing in: nothing',
      '',
      ...s.elements.map((e) => `${e.role.replace(/^AX/, '').padEnd(14)} ${JSON.stringify(e.label)}${'value' in e ? ` = ${JSON.stringify(e.value)}` : ''}   @${Math.round(e.x)},${Math.round(e.y)}${e.hidden ? ' (hidden)' : ''}`),
    ];
    const file = path.join(app.getPath('userData'), 'what-i-can-see.txt');
    fs.writeFileSync(file, lines.join('\n'));
    shell.openPath(file);
    console.log(`[scan] wrote ${file}`);
  } catch (err) {
    console.error('[scan] debug dump', err.message);
  }
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('👀');
  tray.setToolTip('Friday · Project Stark');
  tray.setContextMenu(buildTrayMenu());
}

// tts://speak/?text=…&mood=… streams the buddy's voice from ElevenLabs, so the
// renderer can start playing before the whole clip exists. Registered before
// the app is ready, as Electron requires.
protocol.registerSchemesAsPrivileged([
  { scheme: 'tts', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
]);

// One buddy at a time: launching it again just wakes the running one up.
// Typed mode can run alongside the normal app, for testing.
const firstInstance = textMode.enabled() || app.requestSingleInstanceLock();
if (!firstInstance) {
  console.log('Friday is already running. Press ⌘⇧Space to talk to it, or quit it from the 👀 menu first.');
  app.exit(0);
} else {
  app.on('second-instance', () => listen('ask'));
}

if (firstInstance) app.whenReady().then(async () => {
  // Before anything else prints: the whole run goes to a log file too.
  try {
    sessionLog.startSessionLog(path.join(app.getPath('userData'), 'logs'));
  } catch (err) {
    console.error('[log] could not start the session log:', err.message);
  }
  cfg = loadConfig(app.getPath('userData'));
  if (textMode.enabled()) startTextMode();
  setPicksFile(path.join(app.getPath('userData'), 'file-picks.json'));
  // Older skills get their one-off tidy-up now, not when someone's waiting for them.
  setTimeout(() => tidyAllSkills().catch((err) => console.error('[skills] tidy all', err.message)), 8000);
  console.log('[config] loaded from', cfg.loadedFrom.length ? cfg.loadedFrom.join(', ') : '(no .env found)');
  console.log('[config] guide:', Guide.available(cfg) ? 'on (Claude)' : 'off (no ANTHROPIC_API_KEY)');
  console.log('[config] voice:', cfg.voiceEnabled ? (cfg.elevenLabs.apiKey ? 'ElevenLabs' : 'system fallback (no ELEVENLABS_API_KEY)') : 'off');

  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  protocol.handle('tts', async (req) => {
    const u = new URL(req.url);
    try {
      const who = AGENTS.includes(u.searchParams.get('agent')) ? u.searchParams.get('agent') : 'friday';
      return await voice.stream(u.searchParams.get('text') || '', cfg, u.searchParams.get('mood') || '', who);
    } catch (err) {
      console.error('[voice]', err.message);
      return new Response('', { status: 502 });
    }
  });

  // The overlay listens to the microphone while you teach it.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  notches = await findNotches();
  createWindow();
  createTray();
  if (typed) {
    // Print what the orb would say, and start reading requests once it's up.
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, payload) => {
      textMode.logSend(channel, payload);
      send(channel, payload);
    };
    win.webContents.once('did-finish-load', () => setTimeout(() => typed.run(), 300));
  }

  if (!globalShortcut.register(ASK_SHORTCUT, () => listen('ask'))) {
    console.warn(`[shortcut] ${ASK_SHORTCUT} is taken by another app; use the menu bar 👀 instead.`);
  }

  screen.on('display-metrics-changed', () => {
    if (win) placeOverlay(screen.getDisplayMatching(win.getBounds()));
  });
});

// ---------- typed, silent mode (src/textmode.js) ----------

let typed = null;
function startTextMode() {
  // No voice, no microphone: nothing goes to ElevenLabs.
  cfg.voiceEnabled = false;
  cfg.wakeEnabled = false;
  wakeEnabled = false;
  typed = textMode.createTextMode({
    handleAsk: (text) => handleAsk(text, 'jarvis'),
    busy: () => Boolean(jarvisRun),
    lessonSay: (text) => Boolean((replay || improv) && guideSay(text)),
    quit: () => app.quit(),
  });
  if (textMode.dryRun()) {
    // Look but don't touch: anything that would change the screen is only logged.
    const dry = (what) => async (...args) => console.log(`[dry] ${what}`, ...args.map((a) => (typeof a === 'object' ? JSON.stringify(a).slice(0, 120) : a)));
    for (const k of ['click', 'type', 'keys', 'selectAll', 'escape', 'scroll']) act[k] = dry(k);
    shell.openPath = async (p) => (console.log('[dry] open', p), '');
    shell.openExternal = dry('open url');
    shell.showItemInFolder = dry('show in Finder');
    windows.bringToFront = dry('bring to front');
    hands.openApp = async (name) => (console.log('[dry] open app', name), true);
  }
  console.log(`[text] typed mode${textMode.dryRun() ? ', dry run' : ''}: voice and mic off`);
}

// Safety net: log unexpected errors instead of crashing the whole app.
process.on('uncaughtException', (err) => console.error('[main] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection', err));

app.on('will-quit', () => {
  stopJarvis('quit');
  globalShortcut.unregisterAll();
  stopInputHook();
});
// A background buddy: closing the Skills Hub (or anything else) never quits it.
// Quit from the 👀 menu instead.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  const spent = usage.summary();
  if (spent) console.log(spent);
  console.log('[app] quitting');
});
process.on('exit', (code) => console.log(`[app] exited with code ${code}`));
