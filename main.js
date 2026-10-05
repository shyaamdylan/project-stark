// Project Stark — main process. Two agents share the orb: Friday learns a task
// from one person and teaches it to another; Jarvis does a learned task for you.
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
const { Guide, findSkill, planReplay, locateTarget } = require('./src/guide');
const { Replay, buildActions } = require('./src/replay');
const { JarvisRun, planRun, riskOf, isYes } = require('./src/jarvis');
const { AGENTS, persona, rendererInfo } = require('./src/persona');
const { findFiles } = require('./src/files');
const act = require('./src/act');
const { Apprentice, cleanUrl, REFINE_VERSION } = require('./src/apprentice');
const { TeachSession } = require('./src/teach');
const { renderWorkMap } = require('./src/workmap-page');
const { transcribe } = require('./src/stt');
const { pathToFileURL } = require('url');
const { findBest, normalize } = require('./src/matcher');
const voice = require('./src/voice');

const ASK_SHORTCUT = 'CommandOrControl+Shift+Space';

let win = null;
let tray = null;
let cfg = null;
let cursorTimer = null;
let agent = 'friday'; // who you're talking to: 'friday' or 'jarvis'

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
    win.webContents.send('config', {
      voice: cfg.voiceEnabled ? (cfg.elevenLabs.apiKey ? 'elevenlabs' : 'system') : 'off',
      shortcut: '⌘⇧Space',
      wakeWord: cfg.wakeWord,
      wakeEnabled: wakeOn(),
      agents: rendererInfo(cfg),
      agent,
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
  try {
    const { agent: named, rest } = splitWake(rawText);
    setAgent(named || who);
    return await (agent === 'jarvis' ? askJarvis(rest) : ask(rest));
  } catch (err) {
    console.error('[ask]', err);
    return { ok: false, reason: 'error', say: persona(agent, cfg).s('Something went wrong{sir}. Try again.') };
  }
});

// Scan everything on screen for a request, or a ready-made reply explaining why not.
async function scanForAsk() {
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
  return { scan };
}

async function ask(text) {
  const { scan, reply } = await scanForAsk();
  if (reply) return reply;

  stopGuide();
  const canGuide = Guide.available(cfg);
  if (canGuide && looksLikeTask(text)) {
    const res = await startGuide(text, scan);
    // Not a learned skill: it may still be one obvious button on screen.
    return res.reason === 'not-learned' ? locateOnScreen(text, scan) : res;
  }

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
async function ensureRefined(id, skill) {
  if ((skill.map.refined || 0) >= REFINE_VERSION || !Guide.available(cfg)) return skill;
  const dir = skillDir(id);
  if (win) win.webContents.send('say', { text: 'Tidying up that lesson first…', speak: false });
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
    return skill;
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
  let found;
  try {
    found = await matchSkill(text);
  } catch (err) {
    console.error('[guide] skill lookup', err.message);
    return { ok: false, reason: 'guide', say: "I couldn't check that just now." };
  }
  if (!found || !found.id) return notLearned;
  if (found.match === 'maybe') {
    // Close, but not certain: check before walking them through the wrong thing.
    pendingClarify = { id: found.id, text, at: Date.now(), agent: 'friday' };
    return { ok: true, clarify: true, question: found.question };
  }
  return beginSkill(found.id, text);
}

// Which learned skill (if any) a request is for. Only asks Claude when the
// request shares a real word with something it has learned.
async function matchSkill(text) {
  const skills = learnedSkills().filter((sk) => sharesWords(text, `${sk.title} ${sk.summary}`));
  if (!skills.length) return null;
  const found = await findSkill(cfg.anthropicApiKey, text, skills);
  console.log(`[skills] "${text}" → ${found.id || 'none'} (${found.match})`);
  return found;
}

// After a clarifying question: yes starts the skill, no says so, anything else is a new request.
let pendingClarify = null;
ipcMain.handle('confirm', async (_e, rawText) => {
  try {
    const text = stripWake(rawText);
    const pending = pendingClarify && Date.now() - pendingClarify.at < 60000 ? pendingClarify : null;
    pendingClarify = null;
    const again = () => (agent === 'jarvis' ? askJarvis(text) : ask(text));
    if (!pending) return again();
    const t = text.toLowerCase();
    if (/^(no|nope|nah|not really|not quite|wrong|neither)\b/.test(t)) {
      return { ok: false, reason: 'not-learned', say: pending.agent === 'jarvis' ? persona('jarvis', cfg).s("Then I'm afraid I haven't been taught that one{sir}.") : "Sorry, I can't do that one yet." };
    }
    if (/^(yes|yeah|yep|yup|sure|correct|right|exactly|that'?s (it|right)|it is|i do|please|ok(ay)?)\b/.test(t)) {
      return pending.agent === 'jarvis' ? beginJarvis(pending.id) : beginSkill(pending.id, pending.text);
    }
    return again();
  } catch (err) {
    console.error('[confirm]', err);
    return { ok: false, reason: 'error', say: 'Something went wrong. Try again.' };
  }
});

async function beginSkill(id, text) {
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
  if (!teach && !jarvisRun) stopInputHook();
}

ipcMain.on('guide-next', () => {
  if (replay) replay.skip();
});
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
  // Only web addresses, opened in the default browser.
  openUrl: async (url) => {
    const safe = cleanUrl(url);
    if (!safe) throw new Error(`not a web address: ${url}`);
    await shell.openExternal(safe);
    console.log(`[jarvis] opened ${safe}`);
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
const LEARN_RE = /^(how (do|can|would|should) i|show me how|teach me|walk me through|guide me)\b/i;

async function askJarvis(text) {
  const p = persona('jarvis', cfg);
  if (teach) return { ok: false, reason: 'busy', say: p.s("Friday is in the middle of a lesson{sir}. I'll wait until she's finished.") };
  stopGuide();
  stopJarvis('new-request');

  // "How do I…" is a request to learn, which is Friday's department.
  if (LEARN_RE.test(text)) {
    setAgent('friday');
    return ask(text);
  }

  const open = OPEN_RE.exec(text);
  if (open && !UI_WORDS.test(open[1])) {
    const res = await openFileRequest(open[1], p);
    if (res) return res;
  }

  if (Guide.available(cfg)) {
    let found = null;
    try {
      found = await matchSkill(text);
    } catch (err) {
      console.error('[jarvis] skill lookup', err.message);
    }
    if (found && found.id) {
      if (found.match === 'maybe') {
        pendingClarify = { id: found.id, text, at: Date.now(), agent: 'jarvis' };
        return { ok: true, clarify: true, question: found.question };
      }
      return beginJarvis(found.id);
    }
  }

  const { scan, reply } = await scanForAsk();
  if (reply) return { ...reply, say: p.s(`${reply.say.replace(/\.$/, '')}{sir}.`) };
  const clickable = scan.elements.filter((e) => CLICKABLE_ROLES.has(e.role) && !e.hidden);

  // "Click Share": he presses it himself.
  const click = CLICK_RE.exec(text);
  if (click) {
    const result = findBest(click[1], clickable);
    if (!result.match || result.score < 0.8) return { ok: false, reason: 'not-found', say: p.s(`I'm afraid I can't see "${click[1]}"{sir}.`) };
    return jarvisClick(result.match, p);
  }

  // Anything else: point at it, like Friday does.
  const result = findBest(text, scan.elements);
  if (result.match && !result.match.hidden) {
    const m = result.match;
    return { ok: true, label: m.label, role: ROLE_NAMES[m.role] || 'thing', app: m.app || scan.app, rect: toLocal(m), say: p.s(`The ${m.label} ${ROLE_NAMES[m.role] || ''} is just there{sir}.`).replace(/ {2,}/g, ' ') };
  }
  return { ok: false, reason: 'not-learned', say: p.s("I'm afraid I haven't been taught that one{sir}. Friday can learn it from someone who knows how.") };
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

// "Open the Q3 report": find it with Spotlight and open it in its usual app.
// Returns null if nothing matches, so the request can be tried as something else.
async function openFileRequest(what, p) {
  let found;
  try {
    found = await findFiles(what);
  } catch (err) {
    console.error('[jarvis] file search', err.message);
    return null;
  }
  console.log(`[jarvis] open "${what}" →`, found.map((f) => `${f.name} (${f.score.toFixed(2)}${f.blocked ? `, ${f.blocked}` : ''})`).join(', ') || 'nothing');
  if (!found.length) return null;

  let pick = found[0];
  const close = found.filter((f) => f.score >= pick.score - 0.05);
  if (close.length > 1) {
    const names = close.slice(0, 3);
    const answer = await askUser(
      p.s(`I found ${names.length} likely candidates: ${names.map((f, i) => `${i + 1}, ${f.name}`).join('; ')}. Which one{sir}?`),
      'jarvis-input'
    );
    if (!answer) return { ok: true, sayOnly: true, say: p.s('Very good. Standing by.') };
    const n = { one: 1, first: 1, '1': 1, two: 2, second: 2, '2': 2, three: 3, third: 3, '3': 3 }[(/\b(one|two|three|first|second|third|[123])\b/i.exec(answer) || [])[1]?.toLowerCase()];
    pick = n ? names[n - 1] : findBest(answer, names.map((f) => ({ ...f, label: f.name, role: 'AXButton' }))).match;
    if (!pick) return { ok: false, reason: 'not-found', say: p.s("I'm afraid I didn't catch which one{sir}.") };
  }

  if (pick.blocked) {
    const why = pick.blocked === 'app-outside-applications'
      ? `I'd rather not launch an app from outside your Applications folder{sir}. "${pick.name}" stays closed.`
      : `"${pick.name}" would run code on your Mac, so I'll leave that one to you{sir}.`;
    console.log(`[jarvis] refused to open ${pick.path} (${pick.blocked})`);
    return { ok: false, reason: 'blocked', say: p.s(why) };
  }
  const err = await shell.openPath(pick.path);
  if (err) {
    console.error('[jarvis] open', pick.path, err);
    return { ok: false, reason: 'error', say: p.s(`I couldn't open "${pick.name}"{sir}.`) };
  }
  console.log(`[jarvis] opened ${pick.path}`);
  return { ok: true, sayOnly: true, say: p.s(`Opening ${pick.name.replace(/\.[^.]+$/, '')}{sir}.`) };
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

  const run = new JarvisRun({
    skill,
    actions,
    plan,
    s: p.s,
    scan: scanFrontWindow,
    act: hands,
    ask: askUser,
    emit: (ev) => {
      if (!jarvisRun || jarvisRun.run !== run || !win) return;
      if (ev.type === 'point') win.webContents.send('jarvis-step', { rect: toLocal(ev.target), label: ev.target.label });
      else win.webContents.send('jarvis-step', { say: ev.say || '', stepNo: ev.stepNo || 0, totalSteps: ev.totalSteps || 0 });
    },
  });
  jarvisRun = { run, id };
  startInputHook();
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (win) win.webContents.send('jarvis-state', { running: true, title: skill.map.title, totalSteps: run.total });
  console.log(`[jarvis] starting "${skill.map.title}" (${actions.length} actions)`);

  // Let the renderer switch into Jarvis mode before the first question arrives.
  setTimeout(async () => {
    const result = await run.run();
    console.log(`[jarvis] "${skill.map.title}" ended: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    if (result.error && result.reason === 'ACCESSIBILITY') systemPreferences.isTrustedAccessibilityClient(true);
    saveRunLog(id, run, result);
    if (jarvisRun && jarvisRun.run === run) jarvisRun = null;
    // A newer run may have taken over (a new request stops the old one): leave it be.
    if (jarvisRun) return;
    cancelQuestions();
    if (!replay && !teach) stopInputHook();
    if (tray) tray.setContextMenu(buildTrayMenu());
    if (win) win.webContents.send('jarvis-state', { running: false, status: result.status, say: result.say });
  }, 200);
  return { ok: true, jarvis: true, title: skill.map.title, totalSteps: run.total };
}

function stopJarvis(reason = 'stopped') {
  if (!jarvisRun) return;
  jarvisRun.run.stop(reason);
  cancelQuestions();
}

// Every run is written down next to the skill: what he asked, what he did, how it ended.
function saveRunLog(id, run, result) {
  try {
    const dir = path.join(skillDir(id), 'runs');
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
      { label: 'Open Accessibility settings', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
      { label: 'Open folder for .env (API keys)', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: 'Quit Project Stark', role: 'quit' },
    ]);
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
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) {
  console.log('Friday is already running. Press ⌘⇧Space to talk to it, or quit it from the 👀 menu first.');
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
  stopJarvis('quit');
  globalShortcut.unregisterAll();
  stopInputHook();
});
// A background buddy: closing the Skills Hub (or anything else) never quits it.
// Quit from the 👀 menu instead.
app.on('window-all-closed', () => {});
app.on('before-quit', () => console.log('[app] quitting'));
process.on('exit', (code) => console.log(`[app] exited with code ${code}`));
