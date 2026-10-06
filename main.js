// Project Alpha — main process.
//
// One transparent, click-through, always-on-top window covers the work area of
// a display. The renderer draws the buddy at the bottom of it. The window only
// accepts the mouse while the cursor is over the buddy or its speech bubble.

const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, systemPreferences, shell, nativeImage } = require('electron');
const path = require('path');
const { loadConfig } = require('./src/config');
const { scanFrontApp, refocusFrontApp } = require('./src/finder');
const { findBest } = require('./src/matcher');
const voice = require('./src/voice');
const { classify, isStop } = require('./src/intent');
const { Organizer } = require('./src/organize');
const { rank, describe, needsFiles, siteCandidates, hostOf } = require('./src/launcher');
const mac = require('./src/mac');

const ASK_SHORTCUT = 'CommandOrControl+Shift+Space';

let win = null;
let tray = null;
let cfg = null;
let cursorTimer = null;
let organizer = null;
// Bumped by "stop": anything started before it must not carry on.
let runId = 0;
let pendingQuestion = null; // { resolve, reject, timer } while waiting for an answer

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

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('config', {
      voice: cfg.voiceEnabled ? (cfg.elevenLabs.apiKey ? 'elevenlabs' : 'system') : 'off',
      shortcut: '⌘⇧Space',
    });
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      win.webContents.send('say', {
        text: "Hi! I need Accessibility permission to see buttons. I've opened System Settings for you.",
        mood: 'worried',
      });
      systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS prompt
    } else {
      win.webContents.send('say', { text: `Hi! Click me or press ⌘⇧Space and tell me what to find.`, mood: 'happy' });
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

function openPrompt() {
  if (!win) return;
  win.setIgnoreMouseEvents(false);
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
  win.webContents.send('open-prompt');
}

// Move the overlay to whichever display contains the target, then return the
// target rect in window-local coordinates.
function toLocal(rect) {
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
};

async function pointAt(text) {
  let scan;
  try {
    scan = await scanFrontApp({ activate: true });
  } catch (err) {
    console.error('[scan]', err.message);
    if (err.code === 'ACCESSIBILITY') {
      systemPreferences.isTrustedAccessibilityClient(true);
      return { ok: false, reason: 'permission', say: "I can't see buttons yet. Please turn on Accessibility for me in System Settings, then ask again." };
    }
    if (err.code === 'AUTOMATION') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
      return { ok: false, reason: 'permission', say: 'I need permission to use System Events. Allow it under Privacy, Automation, then try again.' };
    }
    return { ok: false, reason: 'error', say: 'Oops, something went wrong while I was looking.' };
  }

  if (scan.error) return { ok: false, reason: scan.error, say: "I couldn't find an app window to look at." };

  const result = findBest(text, scan.elements);
  console.log(`[ask] "${text}" in ${scan.app}: ${scan.elements.length} elements, best=`, result.match, result.score.toFixed(2));

  if (!result.match) {
    const what = result.query.phrase || text;
    const hint = result.suggestions.length ? ` Did you mean ${result.suggestions.map((s) => `"${s}"`).join(' or ')}?` : '';
    return { ok: false, reason: 'not-found', say: `Hmm, I can't find "${what}" in ${scan.app}.${hint}` };
  }

  const m = result.match;
  return {
    ok: true,
    label: m.label,
    role: ROLE_NAMES[m.role] || 'thing',
    app: scan.app,
    rect: toLocal(m),
    say: `There's the "${m.label}" ${ROLE_NAMES[m.role] || ''}!`.replace(' !', '!'),
  };
}

// ---------- requests ----------

const done = (say, mood = 'happy') => ({ ok: true, kind: 'done', say, mood });
const fail = (say, reason = 'error') => ({ ok: false, reason, say });

function permissionReply(err) {
  const msg = String(err && err.message);
  if (/-1719|-25211|assistive access/i.test(msg)) {
    systemPreferences.isTrustedAccessibilityClient(true);
    return fail("I need Accessibility permission for that. Please turn it on for me in System Settings, then ask again.", 'permission');
  }
  if (/-1743|not allowed to send/i.test(msg)) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
    return fail('I need permission to control that. Allow it under Privacy, Automation, then try again.', 'permission');
  }
  return null;
}

ipcMain.handle('ask', async (_e, text) => {
  const myRun = ++runId;
  const intent = classify(text);
  console.log('[ask]', JSON.stringify(text), '->', intent.kind, intent.mode || '');
  try {
    if (intent.kind === 'stop') {
      stopAll();
      return { ok: true, kind: 'stopped' };
    }
    if (intent.kind !== 'point' && process.platform !== 'darwin') return fail('That only works on a Mac for now.');
    if (intent.kind === 'organize') return done((await organizer.run(text, { cleanup: intent.cleanup, focus: intent.focus, stopped: () => myRun !== runId })).say);
    if (intent.kind === 'undo') return done((await organizer.undo()).say);
    if (intent.kind === 'launch') return await launch(intent);

    const res = await pointAt(intent.text);
    if (res.ok || res.reason !== 'not-found' || !intent.fallback || myRun !== runId) return res;
    // Nothing on screen by that name: maybe it's an app, file or site.
    const alt = await launch(intent.fallback, { quietMiss: true });
    return alt.ok ? alt : res;
  } catch (err) {
    if (err.code === 'STOPPED' || myRun !== runId) return { ok: true, kind: 'stopped' };
    console.error('[ask]', err);
    if (err.code === 'NO-KEEP') return fail(err.message, 'not-found');
    return permissionReply(err) || fail('Oops, something went wrong while I was doing that.');
  }
});

async function launch(req, { quietMiss = false } = {}) {
  if (req.mode === 'search') {
    await shell.openExternal(req.url);
    return done(`Searching ${req.engine === 'web' || req.engine === 'internet' ? 'the web' : req.engine} for "${req.query}".`);
  }

  let windows = [];
  let tabs = [];
  try {
    ({ windows, tabs } = await mac.listWindows({ tabs: true }));
  } catch (err) {
    // Still useful without window access: apps, projects, files and sites work.
    console.warn('[launch] window list failed:', err.message);
  }
  const candidates = [
    ...windows.filter((w) => !w.sheet).map((w) => ({ ...w, type: 'window' })),
    ...tabs.map((t) => ({ ...t, type: 'tab', tabIndex: t.tab })),
    ...mac.listApps(),
    ...mac.listProjects(cfg.jarvis.projectDirs),
    ...siteCandidates(),
  ];
  if (req.url) candidates.push({ type: 'site', name: req.query, aliases: [], url: req.url, host: hostOf(req.url) });

  let r = rank(req, candidates);
  if (needsFiles(req, r.best)) r = rank(req, candidates.concat(await mac.searchFiles(req.query)));

  if (!r.best) {
    if (quietMiss) return fail('', 'not-found');
    const near = r.ranked[0] && r.ranked[0].score > 0.35 ? ` The closest I found was "${r.ranked[0].c.name || r.ranked[0].c.title || r.ranked[0].c.app}".` : '';
    return fail(`I couldn't find "${req.query}".${near}`, 'not-found');
  }

  const c = r.best.c;
  const d = describe(req, r.best);
  let say = d.say;
  switch (d.action) {
    case 'focus-window': await mac.focusWindow(c); break;
    case 'focus-tab':
      // Some browsers (e.g. Arc) can't select a tab by index; open its address instead.
      await mac.focusTab({ app: c.app, window: c.window, tab: c.tabIndex }).catch(() => shell.openExternal(c.url));
      break;
    case 'open-app': await mac.openApp(c); break;
    case 'open-project': {
      const editor = await mac.openProject(c, cfg.jarvis.editor);
      if (editor) say = `Opening ${c.name} in ${editor}.`;
      break;
    }
    case 'open-path': {
      const err = await shell.openPath(c.path);
      if (err) return fail(`I found ${c.name} but couldn't open it: ${err}`);
      break;
    }
    case 'reveal': shell.showItemInFolder(c.path); break;
    case 'open-url': await shell.openExternal(c.url); break;
    default: return fail(`I couldn't find "${req.query}".`, 'not-found');
  }
  if (r.close) {
    const o = r.close.c;
    say += ` Not it? There's also the ${o.type === 'tab' ? 'tab' : o.type} "${o.name || o.title || o.app}".`;
  }
  return done(say);
}

// ---------- asking the user one question ----------

function askUser(question) {
  return new Promise((resolve, reject) => {
    if (pendingQuestion) pendingQuestion.resolve('no');
    const myRun = runId;
    const timer = setTimeout(() => finishQuestion('no'), 90000); // no answer = close nothing
    pendingQuestion = { resolve, reject, timer, run: myRun };
    win.setIgnoreMouseEvents(false);
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus();
    const firstLine = question.split('\n')[0];
    win.webContents.send('question', { text: question, speak: `${firstLine} Say yes, no, or the numbers.` });
  });
}

function finishQuestion(answer) {
  if (!pendingQuestion) return;
  const q = pendingQuestion;
  pendingQuestion = null;
  clearTimeout(q.timer);
  if (answer === null) q.reject(Object.assign(new Error('stopped'), { code: 'STOPPED' }));
  else q.resolve(answer);
}

ipcMain.on('answer', (_e, text) => {
  if (isStop(text)) return stopAll();
  finishQuestion(String(text || ''));
});

// "stop" / the ■ button: drop everything and go quiet.
function stopAll() {
  runId++;
  finishQuestion(null);
  if (win && !win.isDestroyed()) {
    win.webContents.send('stopped');
    win.setIgnoreMouseEvents(true, { forward: true });
  }
}

ipcMain.on('stop', () => stopAll());

ipcMain.handle('speak', async (_e, text) => {
  try {
    return { audio: await voice.synthesize(text, cfg) };
  } catch (err) {
    console.error('[voice]', err.message);
    return { audio: null, error: err.message };
  }
});

ipcMain.on('set-interactive', (_e, interactive) => {
  if (!win) return;
  if (interactive) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on('open-prompt', () => openPrompt());

ipcMain.on('prompt-closed', () => {
  if (!win) return;
  win.setIgnoreMouseEvents(true, { forward: true });
  refocusFrontApp(); // hand keyboard focus back to what you were using
});

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('👀');
  tray.setToolTip('Project Alpha');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ask buddy…', accelerator: ASK_SHORTCUT, click: openPrompt },
      { label: 'Stop', click: stopAll },
      { label: 'Undo last organise', click: () => organizer.undo().then((r) => win.webContents.send('say', { text: r.say, mood: 'happy' })) },
      { label: 'Open Accessibility settings', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
      { label: 'Open folder for .env (API keys)', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: 'Quit Project Alpha', role: 'quit' },
    ])
  );
}

app.whenReady().then(() => {
  cfg = loadConfig(app.getPath('userData'));
  console.log('[config] loaded from', cfg.loadedFrom.length ? cfg.loadedFrom.join(', ') : '(no .env found)');
  console.log('[config] voice:', cfg.voiceEnabled ? (cfg.elevenLabs.apiKey ? 'ElevenLabs' : 'system fallback (no ELEVENLABS_API_KEY)') : 'off');

  organizer = new Organizer({
    file: path.join(app.getPath('userData'), 'last-layout.json'),
    inventory: async () => (await mac.listWindows()).windows,
    change: (op) => mac.changeWindow(op),
    ask: (question) => askUser(question),
    area: () => screen.getPrimaryDisplay().workArea,
    closableApps: cfg.jarvis.closableApps,
    profiles: cfg.jarvis.profiles,
  });

  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWindow();
  createTray();

  if (!globalShortcut.register(ASK_SHORTCUT, openPrompt)) {
    console.warn(`[shortcut] ${ASK_SHORTCUT} is taken by another app; use the menu bar 👀 instead.`);
  }

  screen.on('display-metrics-changed', () => {
    if (win) win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea);
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
