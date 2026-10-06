// Project Stark — the orb's behaviour (renderer process).
//
// Two agents share the orb: Friday (cool blue, learns and teaches) and Jarvis
// (Iron Man gold, does learned tasks for you). The orb's colours, voice and
// phrases follow whoever you're talking to.
//
// The buddy is a glowing ball of energy that lives in the MacBook's notch (or
// the bottom-right corner on a screen without one).
// To point at something it squeezes a droplet of itself out (a gooey SVG
// filter melts the two shapes together until they pinch apart), flings it
// across the screen as a spark, and the spark becomes the cursor. Afterwards
// the spark flies home and is absorbed back in.

const $ = (id) => document.getElementById(id);
const buddyEl = $('buddy');
const orbEl = $('orb');
const bodyEl = $('body');
const plasmaEl = $('plasma');
const dropEl = $('drop');
const neckEl = $('neck');
const glintEl = $('glint');
const bubble = $('bubble');
const sayEl = $('say');
const askForm = $('ask');
const askInput = $('ask-input');
const spot = $('spot');
const spotLabel = $('spot-label');
const spark = $('spark');
const guideBar = $('guide-bar');
const guideNote = $('guide-note');
const guideCount = $('guide-count');
const pointer = $('pointer');

const POINTER_TIP = { x: 3.75, y: 2.5 }; // arrow tip inside the 30px svg
const SQUEEZE_DIST = 76; // how far the droplet stretches before it lets go
const TRAILS = 7;

const state = {
  cursor: { x: 0, y: 0 },
  busy: false,
  promptOpen: false,
  guiding: false,
  teaching: false,
  executing: false, // Jarvis is doing a task
  agent: 'friday',
  agents: {}, // name, wake word and phrases per agent (from main, see src/persona.js)
  listening: null, // 'ask' or 'teach-name' while ⌘⇧Space is listening
  wakeEnabled: false,
  wakeRes: [], // [{ agent, re }]: "hey friday", "ok jarvis", "friday," at the start of what you say
  micLevel: 0,
  lastSpoken: '',
  lastSpokenAt: 0,
  answering: null, // id of the question being answered
  typingAnswer: false, // they clicked the answer box to type instead of talking
  convoUntil: 0, // after an exchange, keep listening (no wake word) until this time
  canHear: false, // speech-to-text available (needs ElevenLabs)
  pointerAt: null, // where the cursor is pointing, while it's out of the orb
  pointerStyle: 'mixed', // 'mixed', 'highlight' (a ring) or 'spark' (a cursor flies out of the orb)
  pointerMode: null, // what's out on screen now: 'ring' or 'cursor'
  wakingUntil: 0, // heard its name mid-sentence: look awake until the request arrives
  resting: false, // left alone a while: shrunk to the dormant look (see QUIET_MS)
  macAudio: false, // another app is playing sound the mic can hear
  exit: null, // where the droplet left the orb, so it can come back the same way
  interactive: false,
  voice: 'system',
  audio: null,
  analyser: null,
  level: 0,
  sayTimer: null,
  speechId: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function flare() {
  buddyEl.classList.remove('flare');
  void buddyEl.offsetWidth; // restart the animation
  buddyEl.classList.add('flare');
  setTimeout(() => buddyEl.classList.remove('flare'), 700);
}

function orbCenter() {
  const r = orbEl.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// ---------- idle life: glint follows the mouse, glow follows the voice ----------

function frame(t) {
  const c = orbCenter();
  const dx = state.cursor.x - c.x;
  const dy = state.cursor.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  // Resting, it stays still: motion is kept for when something is happening.
  const reach = lively() ? Math.min(14, d / 40) : 0;
  glintEl.style.transform = `translate(${(dx / d) * reach}px, ${(dy / d) * reach}px)`;

  let target = 0;
  if (buddyEl.classList.contains('hearing')) {
    target = state.micLevel;
  } else if (buddyEl.classList.contains('talking')) {
    if (state.analyser) {
      const buf = new Uint8Array(state.analyser.fftSize);
      state.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      target = clamp(Math.sqrt(sum / buf.length) * 4, 0, 1);
    } else {
      // System voice gives us no audio to measure, so shimmer in a speech-ish rhythm.
      const s = t / 1000;
      target = 0.3 + 0.55 * Math.abs(Math.sin(s * 13) * Math.sin(s * 7.3 + 1));
    }
  }
  state.level += (target - state.level) * (target > state.level ? 0.5 : 0.12);
  orbEl.style.setProperty('--level', state.level.toFixed(3));
  showStatus();
  requestAnimationFrame(frame);
}

// Awake (in a conversation) or dormant (only listening for its name), and what
// it's doing right now, so you can always tell at a glance.
const statusEl = $('status');
let shownStatus = null;
// ---------- resting when left alone ----------
//
// After a while with nothing happening (no speech either way, no step, no
// typing, no hover), it shrinks back to its small dormant form, even with a
// lesson or a question still open: nothing is lost, it just gets out of the
// way. The next thing that happens brings it straight back.
const QUIET_MS = 15000;
let lastActivity = Date.now();
function active() {
  lastActivity = Date.now();
  if (state.resting) {
    state.resting = false;
    document.body.classList.remove('resting');
    shownStatus = null; // redraw the awake look
    fitShell();
  }
}
setInterval(() => {
  if (state.resting) return;
  const busyNow = ['talking', 'hearing', 'thinking'].some((c) => buddyEl.classList.contains(c)) || state.typingAnswer || state.guideTyping || state.promptOpen;
  if (busyNow) {
    lastActivity = Date.now();
    return;
  }
  if (Date.now() - lastActivity < QUIET_MS) return;
  state.resting = true;
  document.body.classList.add('resting');
  shownStatus = null;
  fitShell();
}, 1000);

// Is it actively engaged: listening to respond (woken by its name or the
// shortcut, a follow-up, a lesson or task) or answering (thinking, talking)?
// Then the orb looks fully awake, even with the panel folded away. Only
// listening for its name is dormant, whatever the mic hears.
function lively() {
  return awake() || state.busy || ['talking', 'thinking'].some((c) => buddyEl.classList.contains(c));
}

function showStatus() {
  const isAwake = lively();
  const talking = buddyEl.classList.contains('talking');
  const thinking = buddyEl.classList.contains('thinking');
  const hearing = buddyEl.classList.contains('hearing');
  const micLive = isAwake && Mic.isOn();
  let label = '';
  let kind = '';
  if (talking) [label, kind] = ['Speaking', 'speaking'];
  else if (thinking) [label, kind] = ['Thinking…', 'thinking'];
  else if (hearing && isAwake) [label, kind] = ['Hearing you', 'listening'];
  else if (state.executing) [label, kind] = ['Working…', 'thinking'];
  else if (micLive) [label, kind] = ['Listening', 'listening'];
  else if (isAwake) [label, kind] = ['Ready', ''];
  const key = `${isAwake}|${label}`;
  if (key === shownStatus) return;
  shownStatus = key;
  buddyEl.classList.toggle('awake', isAwake);
  buddyEl.classList.toggle('dormant', !isAwake);
  statusEl.textContent = label;
  statusEl.className = label ? kind : 'hidden';
}

// Measure ElevenLabs audio so the glow pulses with the actual voice. If the
// AudioContext isn't allowed to run (no user gesture yet), play the audio
// untouched instead: routing it through a suspended context would mute it.
let audioCtx = null;
function listenTo(audio) {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state !== 'running') audioCtx.resume();
    if (audioCtx.state !== 'running') return;
    const src = audioCtx.createMediaElementSource(audio);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    state.analyser = analyser;
  } catch {
    state.analyser = null;
  }
}

// ---------- squeezing out, flying, becoming the cursor ----------

// Lean/squash along an angle: rotate into the direction, scale, rotate back.
const along = (a, sx, sy, tx = 0, ty = 0) => `translate(${tx}px, ${ty}px) rotate(${a}rad) scale(${sx}, ${sy}) rotate(${-a}rad)`;

// A droplet stretches out of the orb toward `target` and pinches off.
// Resolves with the screen point where it detached.
async function squeezeOut(target) {
  const c = orbCenter();
  const a = Math.atan2(target.y - c.y, target.x - c.x);
  const ux = Math.cos(a), uy = Math.sin(a);
  const D = SQUEEZE_DIST;
  const ms = 950;

  const lean = [
    { transform: 'none' },
    { transform: along(a, 1.12, 0.9, ux * 7, uy * 7), offset: 0.5 },
    { transform: along(a, 1.06, 0.95, ux * 4, uy * 4), offset: 0.7 },
    { transform: along(a, 0.93, 1.05, -ux * 2, -uy * 2), offset: 0.85 },
    { transform: 'none' },
  ];
  bodyEl.animate(lean, { duration: ms, easing: 'ease-in-out' });
  plasmaEl.animate(lean, { duration: ms, easing: 'ease-in-out' });

  const at = (f, scale) => `translate(${ux * D * f}px, ${uy * D * f}px) scale(${scale})`;
  dropEl.classList.remove('hidden');
  neckEl.classList.remove('hidden');
  neckEl.animate(
    [
      { transform: at(0, 0.6), offset: 0 },
      { transform: at(0.2, 1), offset: 0.35 },
      { transform: at(0.36, 0.75), offset: 0.6 },
      { transform: at(0.45, 0.35), offset: 0.72 },
      { transform: at(0.5, 0), offset: 0.8 },
      { transform: at(0.5, 0), offset: 1 },
    ],
    { duration: ms, easing: 'ease-in-out', fill: 'forwards' }
  );
  await dropEl.animate(
    [
      { transform: at(0, 0.5), offset: 0 },
      { transform: at(0.35, 0.8), offset: 0.35 },
      { transform: at(0.62, 0.95), offset: 0.6 },
      { transform: at(0.85, 1), offset: 0.78 },
      { transform: at(1, 0.9), offset: 1 },
    ],
    { duration: ms, easing: 'ease-in-out', fill: 'forwards' }
  ).finished;
  for (const el of [dropEl, neckEl]) {
    el.classList.add('hidden');
    el.getAnimations().forEach((x) => x.cancel());
  }
  return { x: c.x + ux * D, y: c.y + uy * D };
}

// The orb lights up (full size and brightness, even from dormant) for the
// spark to squeeze out of it, or to swallow it back, then settles again.
// It doesn't open the panel: it's only the orb.
const LIGHT_MS = 300; // how long a dormant orb takes to swell
async function lightUp() {
  const wasDim = buddyEl.classList.contains('dormant') && !buddyEl.classList.contains('lit');
  buddyEl.classList.add('lit');
  if (wasDim) await sleep(LIGHT_MS);
}
function lightDown() {
  buddyEl.classList.remove('lit');
}

// Where a spark leaves or rejoins the orb when heading to or from `p`: just
// outside wherever the orb is right now (it may have moved since).
function orbEdgeToward(p) {
  const c = orbCenter();
  const a = Math.atan2(p.y - c.y, p.x - c.x);
  return { x: c.x + Math.cos(a) * SQUEEZE_DIST, y: c.y + Math.sin(a) * SQUEEZE_DIST };
}

// The reverse: the droplet arrives at `from` and melts back into the orb.
async function absorb(from) {
  const c = orbCenter();
  const dx = from.x - c.x, dy = from.y - c.y;
  const a = Math.atan2(dy, dx);
  dropEl.classList.remove('hidden');
  const ms = 520;
  bodyEl.animate(
    [{ transform: 'none' }, { transform: along(a, 1.08, 0.94, Math.cos(a) * 4, Math.sin(a) * 4), offset: 0.6 }, { transform: 'none' }],
    { duration: ms + 150, easing: 'ease-in-out' }
  );
  await dropEl.animate(
    [{ transform: `translate(${dx}px, ${dy}px) scale(0.9)` }, { transform: 'translate(0px, 0px) scale(0.4)' }],
    { duration: ms, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' }
  ).finished;
  dropEl.classList.add('hidden');
  dropEl.getAnimations().forEach((x) => x.cancel());
  flare();
}

const trails = Array.from({ length: TRAILS }, () => {
  const t = document.createElement('div');
  t.className = 'trail hidden';
  document.body.appendChild(t);
  return t;
});

// Spark flies along a gentle arc, with a comet tail of fading copies.
async function flySpark(from, to) {
  const ctrl = { x: (from.x + to.x) / 2 + (to.y - from.y) * 0.22, y: Math.min(from.y, to.y) - 90 };
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    pts.push({
      x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * ctrl.x + t ** 2 * to.x,
      y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * ctrl.y + t ** 2 * to.y,
    });
  }
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  // Walkthroughs hop quickly so they keep up with the user.
  const duration = state.guiding ? clamp(dist * 0.4, 200, 480) : clamp(dist * 0.75, 380, 950);
  const opts = { duration, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' };
  const framesAt = (scale) => pts.map((p) => ({ transform: `translate(${p.x}px, ${p.y}px) scale(${scale})` }));

  spark.classList.remove('hidden');
  const flights = trails.map((el, i) => {
    el.classList.remove('hidden');
    el.style.opacity = String(0.6 - i * 0.075);
    return el.animate(framesAt(0.85 - i * 0.09), { ...opts, delay: (i + 1) * 14 }).finished.then(() => el.classList.add('hidden'));
  });
  await spark.animate(framesAt(1), opts).finished;
  await Promise.all(flights);
}

// Spark collapses into a point and the cursor blooms out of it, then taps
// `taps` times (Infinity keeps tapping until it moves on).
async function sparkToCursor(at, taps = 3) {
  const base = `translate(${at.x - POINTER_TIP.x}px, ${at.y - POINTER_TIP.y}px)`;
  pointer.style.transformOrigin = `${POINTER_TIP.x}px ${POINTER_TIP.y}px`;
  pointer.classList.remove('hidden');
  spark.animate(
    [{ transform: `translate(${at.x}px, ${at.y}px) scale(1)`, opacity: 1 }, { transform: `translate(${at.x}px, ${at.y}px) scale(0.2)`, opacity: 0 }],
    { duration: state.guiding ? 140 : 220, easing: 'ease-in', fill: 'forwards' }
  ).finished.then(() => spark.classList.add('hidden'));
  await pointer.animate(
    [
      { transform: `${base} scale(0.2) rotate(-25deg)`, opacity: 0 },
      { transform: `${base} scale(1.2) rotate(4deg)`, opacity: 1, offset: 0.65 },
      { transform: `${base} scale(1) rotate(0deg)`, opacity: 1 },
    ],
    { duration: state.guiding ? 240 : 380, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'forwards' }
  ).finished;
  // Little "tap" while it waits there.
  pointer.animate(
    [
      { transform: `${base} scale(1)` },
      { transform: `translate(${at.x - POINTER_TIP.x + 3}px, ${at.y - POINTER_TIP.y + 3}px) scale(0.88)` },
      { transform: `${base} scale(1)` },
    ],
    { duration: taps === Infinity ? 1100 : 650, iterations: taps, fill: 'forwards' }
  );
}

async function cursorToSpark(at) {
  const base = `translate(${at.x - POINTER_TIP.x}px, ${at.y - POINTER_TIP.y}px)`;
  pointer.getAnimations().forEach((x) => x.cancel());
  const out = pointer.animate(
    [{ transform: `${base} scale(1)`, opacity: 1 }, { transform: `${base} scale(0.2) rotate(25deg)`, opacity: 0 }],
    { duration: state.guiding ? 140 : 240, easing: 'ease-in', fill: 'forwards' }
  ).finished;
  spark.getAnimations().forEach((x) => x.cancel());
  spark.classList.remove('hidden');
  await spark.animate(
    [{ transform: `translate(${at.x}px, ${at.y}px) scale(0.2)`, opacity: 0 }, { transform: `translate(${at.x}px, ${at.y}px) scale(1)`, opacity: 1 }],
    { duration: state.guiding ? 140 : 240, easing: 'ease-out', fill: 'forwards' }
  ).finished;
  await out;
  pointer.classList.add('hidden');
  pointer.getAnimations().forEach((x) => x.cancel());
}

// Send the cursor to a rect: squeezed out of the orb the first time, hopping
// straight from the last target after that.
// After pointing at something, the cursor lingers there for a while instead
// of flying straight home: if the next answer points somewhere too, it glides
// from where it is rather than going back into the orb and out again.
const LINGER_MS = 12000;
let homeTimer = null;
let homing = null; // the trip home in progress, if any

function goHomeLater(ms = LINGER_MS) {
  clearTimeout(homeTimer);
  if (!state.pointerAt) return;
  homeTimer = setTimeout(() => {
    // Not while it's busy pointing out a lesson step or Jarvis's next click.
    if (!state.guiding && !state.executing && !state.busy) goHome();
  }, ms);
}

// How to point this time. "mixed" (the default): Friday squeezes a spark out
// of the orb that becomes the cursor and glides from target to target; Jarvis,
// while he works, uses a calm ring, never a cursor that looks like yours.
// POINTER_STYLE=spark or highlight uses one everywhere.
function pointStyleNow() {
  if (state.pointerStyle !== 'mixed') return state.pointerStyle;
  // Jarvis at work: a ring, never a cursor that could be mistaken for yours.
  if (state.executing) return 'highlight';
  // Friday: the spark squeezes out of the orb and becomes the cursor, gliding
  // from one thing to the next.
  return 'spark';
}

// warn: a decision she's stopped them on; the ring turns amber and says "Check this".
async function pointTo(rect, label, taps = 3, { warn = false } = {}) {
  state.spotWarn = warn;
  clearTimeout(homeTimer);
  if (homing) await homing; // already on its way back: let it land, then go out again
  const center = { x: rect.x + rect.w / 2, y: Math.max(4, rect.y + rect.h / 2) };
  const style = pointStyleNow();
  // A cursor out on screen when the ring takes over: put it away first.
  if (style !== 'spark' && state.pointerMode === 'cursor') {
    for (const el of [pointer, spark]) {
      el.getAnimations().forEach((x) => x.cancel());
      el.classList.add('hidden');
    }
  }
  // Highlight: a calm ring around the thing itself, gliding from one target to
  // the next. No cursor, so it's never mistaken for your mouse.
  if (style === 'highlight') {
    if (!state.pointerAt) flare();
    spot.classList.remove('fading');
    showSpot(rect, label);
    state.pointerAt = center;
    state.pointerMode = 'ring';
    return;
  }
  // Arrive: the spark squeezes out and flies there, then blooms into the ring.
  if (style === 'arrive') {
    spot.classList.add('hidden');
    await lightUp();
    flare();
    state.exit = await squeezeOut(center);
    lightDown();
    await flySpark(state.exit, center);
    await spark.animate(
      [{ transform: `translate(${center.x}px, ${center.y}px) scale(1)`, opacity: 1 }, { transform: `translate(${center.x}px, ${center.y}px) scale(2.4)`, opacity: 0 }],
      { duration: 220, easing: 'ease-out', fill: 'forwards' }
    ).finished;
    spark.classList.add('hidden');
    spark.getAnimations().forEach((x) => x.cancel());
    spot.classList.remove('fading');
    showSpot(rect, label);
    state.pointerAt = center;
    state.pointerMode = 'ring';
    return;
  }
  if (state.pointerAt) {
    spot.classList.add('hidden');
    await cursorToSpark(state.pointerAt);
    await flySpark(state.pointerAt, center);
  } else {
    // Out of the orb: it lights up, squeezes the droplet out, then settles.
    await lightUp();
    flare();
    state.exit = await squeezeOut(center);
    lightDown();
    await flySpark(state.exit, center);
  }
  showSpot(rect, label);
  await sparkToCursor(center, taps);
  state.pointerAt = center;
  state.pointerMode = 'cursor';
}

// Put the pointing away: a ring fades where it is; a cursor flies home and
// melts back into the orb.
async function goHome() {
  clearTimeout(homeTimer);
  if (!state.pointerAt) return;
  const from = state.pointerAt;
  state.pointerAt = null;
  if (state.pointerMode !== 'cursor') {
    spot.classList.add('fading');
    await sleep(300);
    if (!state.pointerAt) clearPointing();
    spot.classList.remove('fading');
    return;
  }
  homing = (async () => {
    spot.classList.add('hidden');
    await cursorToSpark(from);
    // The orb lights up to take it back (it swells while the spark flies),
    // swallows it, and goes back to however it was.
    const lit = lightUp();
    const back = orbEdgeToward(from);
    await flySpark(from, back);
    await lit;
    spark.classList.add('hidden');
    await absorb(back);
    clearPointing();
    lightDown();
  })();
  try {
    await homing;
  } finally {
    homing = null;
  }
}

function showSpot(rect, label) {
  const pad = 6;
  // The target may sit in the menu bar, just above our window. Clamp so the
  // ring still shows at the very top edge.
  const top = Math.max(2, rect.y - pad);
  spot.style.left = `${rect.x - pad}px`;
  spot.style.top = `${top}px`;
  spot.style.width = `${rect.w + pad * 2}px`;
  spot.style.height = `${Math.max(10, rect.y + rect.h + pad - top)}px`;
  spot.classList.toggle('above', rect.y > window.innerHeight - 120);
  spotLabel.textContent = state.spotWarn ? 'Check this' : label;
  spot.classList.toggle('warn', Boolean(state.spotWarn));
  spot.classList.remove('hidden');
}

function clearPointing() {
  state.pointerMode = null;
  spot.classList.add('hidden');
  for (const el of [pointer, spark, dropEl, neckEl, ...trails]) {
    el.getAnimations().forEach((a) => a.cancel());
    el.classList.add('hidden');
  }
}

// ---------- speech bubble + voice ----------

function showBubble() {
  bubble.classList.remove('hidden');
}

function hideBubbleIfIdle() {
  if (!state.promptOpen && !state.guiding && !state.executing && !state.answering && !state.listening) {
    bubble.classList.add('hidden');
    sayEl.textContent = '';
  }
}

function stopSpeaking() {
  state.speechId++;
  state.analyser = null;
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  buddyEl.classList.remove('talking');
}

// Show text in the bubble and speak it. Resolves when finished talking.
// show: false speaks it without the bubble (the task panel shows it instead).
async function say(text, { mood, hold = 0, speak = true, show = true } = {}) {
  active();
  clearTimeout(state.sayTimer);
  stopSpeaking();
  const id = state.speechId;
  if (speak) {
    state.lastSpoken = text;
    state.lastSpokenAt = Date.now();
  }
  if (show) {
    sayEl.textContent = text;
    showBubble();
  }
  buddyEl.classList.remove('happy', 'worried');
  if (mood) buddyEl.classList.add(mood);

  const minMs = Math.max(1800, text.length * 55);
  const started = Date.now();
  if (speak && state.voice !== 'off') await voiceOut(text, id, mood);
  const elapsed = Date.now() - started;
  if (id !== state.speechId) return;

  if (!show) return;
  state.sayTimer = setTimeout(() => {
    if (id !== state.speechId) return;
    buddyEl.classList.remove('worried');
    hideBubbleIfIdle();
  }, Math.max(0, minMs - elapsed) + hold);
}

async function voiceOut(text, id, mood) {
  buddyEl.classList.add('talking');
  try {
    if (state.voice === 'elevenlabs') {
      // Streamed: playback starts as soon as the first audio arrives.
      const ok = await playAudio(`tts://speak/?text=${encodeURIComponent(text)}&mood=${encodeURIComponent(mood || '')}&agent=${state.agent}`, id);
      if (ok || id !== state.speechId) return;
    }
    await systemSpeak(text, id);
  } finally {
    if (id === state.speechId) buddyEl.classList.remove('talking');
  }
}

// Resolves true when the clip played, false if it couldn't (then we fall back).
function playAudio(src, id) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.crossOrigin = 'anonymous'; // lets the analyser read it, so the orb glows with the voice
    a.src = src;
    state.audio = a;
    listenTo(a);
    a.onended = () => resolve(true);
    a.onerror = () => resolve(false);
    a.play().catch(() => resolve(false));
    const guard = setInterval(() => {
      if (id !== state.speechId) {
        clearInterval(guard);
        resolve();
      }
    }, 100);
    a.addEventListener('ended', () => clearInterval(guard));
  });
}

function systemSpeak(text, id) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    if (state.agent === 'jarvis') {
      // A British voice if the Mac has one (Daniel is built in), a little lower and steadier.
      const voices = speechSynthesis.getVoices();
      const v = voices.find((x) => /daniel/i.test(x.name)) || voices.find((x) => x.lang === 'en-GB');
      if (v) u.voice = v;
      u.rate = 1.0;
      u.pitch = 0.9;
    } else {
      u.rate = 1.05;
      u.pitch = 1.25;
    }
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
    setTimeout(resolve, 15000); // never hang
    const guard = setInterval(() => {
      if (id !== state.speechId) {
        clearInterval(guard);
        resolve();
      }
    }, 100);
  });
}

// ---------- sounding natural while it thinks ----------
//
// A short "Hmm…" or "One sec…" covers a wait so it feels like a conversation,
// and "Got it." acknowledges an answer. Phrases come out of a shuffled bag, so
// none repeats until the rest have been used, and fillers are sometimes
// skipped altogether. Each agent has its own lists (src/persona.js, sent with
// the config), made ahead in main.js so they play instantly.

function phraseBag(list) {
  let bag = [];
  let last = null;
  return () => {
    if (!bag.length) {
      bag = list.slice().sort(() => Math.random() - 0.5);
      if (bag[0] === last) bag.push(bag.shift()); // never the same twice in a row
    }
    last = bag.shift();
    return last;
  };
}
const bags = {};
function nextPhrase(kind) {
  const key = `${state.agent}:${kind}`;
  const agent = state.agents[state.agent];
  if (!bags[key]) bags[key] = phraseBag((agent && agent[kind]) || ['…']);
  return bags[key]();
}
const nextFiller = () => nextPhrase('fillers');
const nextAck = () => nextPhrase('acks');

// Say a filler if the wait goes past `afterMs` (most of the time, not always).
// Returns a function that cancels it once the real answer is ready.
function fillWait(afterMs = 550) {
  const t = setTimeout(() => {
    if (Math.random() < 0.8) say(nextFiller(), { hold: 60000 });
  }, afterMs);
  return () => clearTimeout(t);
}

// ---------- asking ----------

function openPrompt({ prefill = '' } = {}) {
  if (state.busy || state.answering) return;
  if (state.guiding) stopGuide();
  state.promptOpen = true;
  clearTimeout(state.sayTimer);
  stopSpeaking();
  sayEl.textContent = '';
  askForm.classList.remove('hidden');
  showBubble();
  askInput.value = prefill;
  setTimeout(() => {
    askInput.focus();
    askInput.setSelectionRange(prefill.length, prefill.length);
  }, 30);
  buddyEl.classList.add('listening');
  flare();
}

function closePrompt({ refocus = true } = {}) {
  if (!state.promptOpen) return;
  state.promptOpen = false;
  buddyEl.classList.remove('listening');
  askForm.classList.add('hidden');
  askInput.blur();
  if (!sayEl.textContent) bubble.classList.add('hidden');
  if (refocus) window.buddy.promptClosed();
}

async function handleConfirm(text) {
  if (state.busy) return;
  state.busy = true;
  try {
    await runAsk(text, () => window.buddy.confirm(text));
  } catch (err) {
    console.error('[confirm]', err);
  } finally {
    state.busy = false;
  }
}

async function handleAsk(input) {
  const { agent, rest: text } = splitWake(input);
  if (agent) switchAgent(agent);
  if (!hasWords(text)) return;
  // "teach: <task>" starts a lesson; "done" ends one.
  const teachCmd = /^teach\s*:\s*(.*)$/i.exec(text);
  if (teachCmd) {
    closePrompt();
    window.buddy.teachStart(teachCmd[1]);
    return;
  }
  if (state.teaching && /^(done|finish(ed)?|stop)$/i.test(text)) {
    closePrompt();
    window.buddy.teachFinish();
    return;
  }

  state.busy = true;
  try {
    await runAsk(text);
    openConvo(); // a follow-up needs no wake word
  } catch (err) {
    // Whatever went wrong, never leave the buddy stuck mid-animation.
    console.error('[ask]', err);
    clearPointing();
    state.pointerAt = null;
    buddyEl.classList.remove('thinking');
    say('Something went wrong. Try again.', { mood: 'worried' });
  } finally {
    state.busy = false;
  }
}

async function runAsk(text, request = () => window.buddy.ask(text, state.agent)) {
  closePrompt({ refocus: false });
  window.buddy.setInteractive(false);
  buddyEl.classList.add('thinking');
  sayEl.textContent = '';
  const cancelFiller = fillWait();

  let res;
  try {
    res = await request();
  } catch (e) {
    res = null;
  }
  cancelFiller();
  buddyEl.classList.remove('thinking');

  if (!res || !res.ok) {
    // Stay put and keep the message up long enough to read.
    await say((res && res.say) || 'Something went wrong. Try again.', { mood: 'worried', hold: 5000 });
    return;
  }

  if (res.clarify) {
    // Not sure it's the skill it knows: ask, then listen for the answer.
    await say(res.question, { mood: 'happy', hold: 15000 });
    state.busy = false;
    startListening('confirm');
    return;
  }

  if (res.jarvis) return; // he's started: see 'jarvis-state' and 'jarvis-step'

  if (res.sayOnly) {
    // Done in one go (opened a file, pressed a button): just say so.
    await say(res.say, { mood: 'happy', hold: 1500 });
    if (res.home) goHomeLater();
    return;
  }

  if (res.guide) {
    // Steps arrive on their own as the user works (see 'guide-step').
    state.guiding = true;
    guideCount.textContent = 'Starting…';
    guideBar.classList.remove('hidden');
    guideAskForm.classList.remove('hidden');
    setTimeout(updateMic, 0); // a lesson is a conversation: the mic is open
    sayEl.textContent = res.title ? `Let's do it: ${res.title}` : '';
    showBubble();
    return;
  }

  sayEl.textContent = '';
  bubble.classList.add('hidden');
  await pointTo(res.rect, res.label);
  await say(res.say, { mood: 'happy', hold: 2500 });
  await sleep(1500);
  hideBubbleIfIdle();
  goHomeLater(); // stays out a while, in case the next question points somewhere too
}

// ---------- guided walkthroughs ----------
//
// The main process sends one step at a time. Steps are animated in order, and
// the cursor hops from target to target without going home in between.

let guideChain = Promise.resolve();
function queueGuide(fn) {
  guideChain = guideChain.then(fn).catch((e) => console.error(e));
  return guideChain;
}

// If the user is quicker than the animation, skip straight to the newest step.
let nextStep = null;
let stepping = false;
async function receiveStep(step) {
  nextStep = step;
  if (stepping) return;
  stepping = true;
  try {
    while (nextStep) {
      const s = nextStep;
      nextStep = null;
      await queueGuide(() => showGuideStep(s));
    }
  } finally {
    stepping = false;
  }
}

async function showGuideStep(step) {
  if (!state.guiding) return;
  buddyEl.classList.remove('thinking');

  nextBtn.disabled = false;
  // What she was pointing at has gone: bring the pointer home quietly. It comes
  // back on its own when the thing is on screen again.
  if (step.retract) {
    await goHome();
    return;
  }
  if (step.status === 'step') {
    guideCount.textContent = step.totalSteps ? `Step ${step.stepNo} of ${step.totalSteps}` : `Step ${step.stepNo}`;
    guideBar.classList.remove('hidden');
    // Speak while the cursor flies, so the two arrive together.
    if (step.say) {
      say(step.say, { mood: 'happy' });
      guideNote.textContent = step.note || '';
      guideNote.classList.toggle('hidden', !step.note);
    }
    if (step.rect) await pointTo(step.rect, step.label, Infinity, { warn: step.flagged });
    // An answer or a check-in leaves the cursor on what they're meant to do.
    else if (!step.quietMove && !step.chat) await goHome();
    return;
  }

  // Finished, or can't go on.
  state.guiding = false;
  guideBar.classList.add('hidden');
  guideAskForm.classList.add('hidden');
  guideNote.classList.add('hidden');
  openConvo();
  if (step.status === 'done') flare();
  goHomeLater();
  await say(step.say, { mood: step.status === 'done' ? 'happy' : 'worried', hold: 2000 });
}

function stopGuide() {
  if (!state.guiding) return;
  state.guiding = false;
  window.buddy.guideStop();
  stopSpeaking();
  guideBar.classList.add('hidden');
  guideAskForm.classList.add('hidden');
  stopGuideTyping();
  setTimeout(updateMic, 0);
  guideNote.classList.add('hidden');
  nextStep = null;
  buddyEl.classList.remove('thinking');
  bubble.classList.add('hidden');
  sayEl.textContent = '';
  queueGuide(goHome);
}

window.buddy.on('guide-step', (step) => {
  active();
  receiveStep(step);
});
const nextBtn = $('guide-next');
function guideThinking() {
  buddyEl.classList.add('thinking');
  guideCount.textContent = 'Thinking…';
  nextBtn.disabled = true;
}
window.buddy.on('guide-thinking', () => {
  if (state.guiding) guideThinking();
});

nextBtn.addEventListener('click', () => {
  if (!state.guiding || nextBtn.disabled) return;
  stopSpeaking();
  guideThinking();
  window.buddy.guideNext();
  // If nothing comes back (it was busy), don't leave the button stuck.
  setTimeout(() => {
    if (nextBtn.disabled) {
      nextBtn.disabled = false;
      buddyEl.classList.remove('thinking');
    }
  }, 6000);
});
// Typing a question mid-lesson: the box takes the keyboard until it's sent.
const guideAskForm = $('guide-ask-form');
const guideAsk = $('guide-ask');
function stopGuideTyping() {
  if (!state.guideTyping) return;
  state.guideTyping = false;
  guideAsk.blur();
  window.buddy.promptClosed();
}
guideAsk.addEventListener('focus', () => {
  if (state.guideTyping) return;
  state.guideTyping = true;
  window.buddy.focusOverlay();
});
guideAsk.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stopGuideTyping();
});
guideAskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = guideAsk.value.trim();
  guideAsk.value = '';
  stopGuideTyping();
  if (!text || !state.guiding) return;
  showCaption(text);
  window.buddy.guideSay(text);
});

$('guide-stop').addEventListener('click', () => (state.executing ? stopJarvis() : stopGuide()));

// ---------- Jarvis at work ----------
//
// Main sends what he's saying, which step he's on, and where he's about to
// click, so the orb's cursor shows each target just before he presses it.

function stopJarvis() {
  if (!state.executing) return;
  window.buddy.jarvisStop();
  stopSpeaking();
  actStep.textContent = 'Stopping…';
}

// ---------- the task panel (like a Live Activity) ----------
//
// While Jarvis works, a small panel by the orb says what he's doing, how far
// along he is, and has a Stop button. His spoken lines go there instead of the
// speech bubble, which is kept for his questions.
const activity = $('activity');
const actTitle = $('act-title');
const actStep = $('act-step');
const actCount = $('act-count');
const actFill = $('act-fill');

function showActivity(title) {
  actTitle.textContent = title || 'Working on it';
  actStep.textContent = 'Getting ready…';
  actCount.textContent = '';
  actFill.style.width = '0%';
  activity.classList.remove('done', 'hidden');
}

function updateActivity({ say: line, stepNo, totalSteps }) {
  if (line) actStep.textContent = line;
  if (stepNo) {
    actCount.textContent = totalSteps ? `${stepNo} of ${totalSteps}` : `Step ${stepNo}`;
    actFill.style.width = totalSteps ? `${Math.min(100, (stepNo / totalSteps) * 100)}%` : '';
    activity.classList.toggle('open-ended', !totalSteps);
  }
}

function endActivity(status, line) {
  if (activity.classList.contains('hidden')) return;
  activity.classList.add('done');
  actStep.textContent = line || (status === 'done' ? 'Done' : 'Stopped');
  if (status === 'done') actFill.style.width = '100%';
  setTimeout(() => activity.classList.add('hidden'), 3500);
}

$('act-stop').addEventListener('click', () => stopJarvis());

window.buddy.on('jarvis-step', (step) =>
  queueGuide(async () => {
    active();
    updateActivity(step);
    if (step.say) say(step.say, { mood: 'happy', hold: 60000, speak: !step.quiet, show: false });
    if (step.rect) await pointTo(step.rect, step.label, Infinity);
  })
);

let afterStop = null; // what they asked for in the same breath as "stop"
window.buddy.on('jarvis-state', (j) => {
  active();
  if (!j.running && afterStop) {
    const next = afterStop;
    afterStop = null;
    state.executing = false;
    activity.classList.add('hidden');
    queueGuide(goHome);
    setTimeout(() => handleAsk(next), 50);
    return;
  }
  if (j.running) {
    // Jarvis asks his questions, then works; steps arrive on 'jarvis-step'.
    if (state.guiding) stopGuide();
    state.executing = true;
    showActivity(j.title);
    hideBubbleIfIdle();
    setTimeout(updateMic, 0);
    return;
  }
  state.executing = false;
  guideNote.classList.add('hidden');
  buddyEl.classList.remove('thinking');
  endActivity(j.status, j.say);
  openConvo();
  queueGuide(async () => {
    if (j.status === 'done') flare();
    goHomeLater();
    if (j.say) await say(j.say, { mood: j.status === 'done' ? 'happy' : 'worried', hold: 2500, show: false });
  });
});

window.buddy.on('question-cancel', () => {
  if (!state.answering) return;
  state.answering = null;
  stopTyping();
  clearTimeout(autoSendTimer);
  answerForm.classList.add('hidden');
  bubble.classList.remove('wide');
  setTimeout(updateMic, 0);
  hideBubbleIfIdle();
});

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = askInput.value.trim();
  if (text) handleAsk(text);
});

askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePrompt();
});

askInput.addEventListener('blur', () => {
  // Clicked away into another app: close quietly.
  setTimeout(() => {
    if (state.promptOpen && document.activeElement !== askInput && !state.busy) closePrompt({ refocus: false });
  }, 150);
});

orbEl.addEventListener('click', () => {
  if (state.executing) return stopJarvis();
  if (state.guiding) return stopGuide();
  if (state.promptOpen) return closePrompt();
  window.buddy.openPrompt();
});

// ---------- teaching (the apprentice watches and asks) ----------

const recEl = $('rec');
const recTitle = $('rec-title');
const recTime = $('rec-time');
const recOff = $('rec-off');
const answerForm = $('answer');
const answerInput = $('answer-input');
const answerPhase = $('answer-phase');
let recTimer = null;

const PHASES = { live: 'Quick question', 'teach-back': 'Did I get it right?', 'jarvis-input': 'Jarvis needs to know', 'jarvis-confirm': 'Your go-ahead' };
const ANSWER_HINTS = {
  'teach-back': "Listening… say what's wrong, or just say yes",
  'jarvis-confirm': 'Listening… say yes to go ahead, or no',
};

window.buddy.on('teach-state', (t) => {
  state.teaching = Boolean(t.recording);
  setTimeout(updateMic, 0);
  clearInterval(recTimer);
  if (t.recording) {
    recTitle.textContent = t.title;
    recEl.classList.toggle('off', Boolean(t.offRecord));
    recOff.textContent = t.offRecord ? 'Resume' : 'Off the record';
    recEl.classList.remove('hidden');
    const tick = () => {
      const s = Math.floor((Date.now() - t.startedAt) / 1000);
      recTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    recTimer = setInterval(tick, 1000);
  } else {
    recEl.classList.add('hidden');
    if (!t.debrief) buddyEl.classList.remove('thinking');
  }
});

window.buddy.on('teach-status', ({ text }) => {
  buddyEl.classList.add('thinking');
  say(text, { speak: false, hold: 60000 });
});

window.buddy.on('teach-question', ({ id, text, phase }) => {
  if (state.promptOpen) closePrompt({ refocus: false });
  buddyEl.classList.remove('thinking');
  state.answering = id;
  bubble.classList.toggle('wide', phase === 'teach-back' || text.length > 120);
  answerPhase.textContent = PHASES[phase] || (phase.startsWith('debrief') ? `Debrief · ${phase.split(' ')[1]}` : '');
  answerInput.textContent = '';
  stopTyping();
  answerInput.dataset.placeholder = ANSWER_HINTS[phase] || 'Listening… answer out loud, or click to type';
  answerForm.classList.remove('hidden');
  updateMic();
  flare();
  say(text, { mood: 'happy' });
});

// Typing an answer: the box takes the keyboard, and nothing is sent until
// Enter (no auto-send on a pause). Speech still adds to it.
function startTyping() {
  if (!state.answering || state.typingAnswer) return;
  state.typingAnswer = true;
  clearTimeout(autoSendTimer);
  window.buddy.focusOverlay();
  setTimeout(() => {
    answerInput.focus();
    // Cursor at the end of anything already heard.
    const r = document.createRange();
    r.selectNodeContents(answerInput);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, 30);
}

// Give the keyboard back to the app they were using.
function stopTyping() {
  if (!state.typingAnswer) return;
  state.typingAnswer = false;
  answerInput.blur();
  window.buddy.promptClosed();
}

answerInput.addEventListener('mousedown', startTyping);
answerInput.addEventListener('focus', startTyping);
answerInput.addEventListener('input', () => clearTimeout(autoSendTimer));
answerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendAnswer(answerInput.textContent);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    stopTyping();
  }
});

function sendAnswer(value) {
  if (!state.answering) return;
  const id = state.answering;
  state.answering = null;
  stopTyping();
  stopSpeaking();
  clearTimeout(autoSendTimer);
  answerForm.classList.add('hidden');
  bubble.classList.remove('wide');
  setTimeout(updateMic, 0);
  bubble.classList.add('hidden');
  sayEl.textContent = '';
  window.buddy.teachAnswer(id, value);
  openConvo();
  if (value && value.trim()) say(nextAck(), { mood: 'happy', hold: 0 });
}

answerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendAnswer(answerInput.textContent);
});
$('answer-skip').addEventListener('click', () => sendAnswer(''));

// ---------- talking to it ----------
//
// While teaching (and while answering), the mic is always on. Speech that
// answers a question goes into the answer box and is sent after a short quiet
// spell; anything else is narration, recorded as part of the lesson.

const captionEl = $('caption');
let captionTimer = null;
let autoSendTimer = null;

function showCaption(text) {
  captionEl.textContent = `“${text}”`;
  captionEl.classList.remove('hidden');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => captionEl.classList.add('hidden'), 4500);
}

// Rough word overlap, to ignore the mic hearing the buddy's own voice.
function similar(a, b) {
  const words = (x) => new Set(x.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean));
  const A = words(a), B = words(b);
  if (!A.size) return false;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / A.size > 0.6;
}

// "Hey Friday, how do I…" -> { woke: true, agent: 'friday', rest: "how do I…" }.
// The wake word never goes further than this: not into requests, answers or narration.
function splitWake(text) {
  for (const { agent, re } of state.wakeRes) {
    const m = re.exec(text);
    if (m) return { woke: true, agent, rest: text.slice(m[0].length).trim() };
  }
  return { woke: false, agent: null, rest: text.trim() };
}
const hasWords = (t) => t.replace(/[^a-z0-9]/gi, '').length >= 2;

// ---------- conversation mode ----------
//
// Once you're talking to it, you don't say "Hey Friday" every time. During a
// lesson, a lesson being taught, or a Jarvis task, the mic is simply open. After
// any other exchange, it stays open for a little while for a follow-up, then
// goes back to dormant (listening only for its name).

const CONVO_MS = 12000;

// "Thanks", "bye", "that's all", "well done": the conversation is over, not a
// new request. The whole utterance has to be one of these, give or take filler.
const CLOSING = /^(?:(?:ok(?:ay)?|cool|great|nice|perfect|awesome|alright|right|yeah|yep|yes|no|um+|uh+|oh|wow|amazing|brilliant|lovely)[\s,.!]*)*(?:thanks?(?: you)?|thank you|cheers|ta|bye(?: bye)?|goodbye|see you|that'?s (?:all|it|everything|great|perfect|so cool|amazing)|never ?mind|nothing|no thanks?|well done|good job|nice one|good work|you'?re (?:the best|amazing|a star))(?:[\s,.!]+(?:bro|mate|man|dude|friday|jarvis|sir|buddy|so much|very much|again|bye|then|for that|for (?:your|the) help|a lot|though|now))*[\s,.!]*$/i;
const isClosing = (t) => CLOSING.test(String(t || '').trim());

function closeConvo() {
  state.convoUntil = 0;
  clearTimeout(convoTimer);
  setTimeout(updateMic, 0);
}
let convoTimer = null;
const convoOpen = () => Date.now() < state.convoUntil;

function openConvo(ms = CONVO_MS) {
  state.convoUntil = Date.now() + ms;
  clearTimeout(convoTimer);
  convoTimer = setTimeout(() => setTimeout(updateMic, 0), ms + 50);
  setTimeout(updateMic, 0);
}

// In a conversation: lesson, task, being taught, a question open, or just talked.
const awake = () => Boolean(state.guiding || state.executing || state.teaching || state.answering || state.listening || state.promptOpen || convoOpen() || state.wakingUntil > Date.now());

// ---------- waking up the moment it hears its name ----------
//
// While dormant, the opening second and a half of what you say is checked for
// "Hey Friday" while you're still talking. The moment it's there the orb wakes
// (grows, brightens, "Hearing you"), so you know it's listening before you've
// finished the sentence.
const WAKING_MS = 15000;
let earlyHead = null; // { id, text: Promise<string> } for the utterance in progress
const isActive = () => Boolean(state.listening || state.answering || state.teaching || state.executing || state.guiding || convoOpen());

function onHead(wav, id) {
  if (isActive() || !state.wakeEnabled) return;
  const text = window.buddy.transcribe(wav).catch(() => '');
  earlyHead = { id, text };
  text.then((t) => {
    const w = splitWake(t);
    if (!earlyHead || earlyHead.id !== id || !w.woke) return;
    if (w.agent && w.agent !== state.agent) applyAgent(w.agent);
    wakeUp();
  });
}

function wakeUp() {
  active();
  if (state.wakingUntil > Date.now()) return;
  state.wakingUntil = Date.now() + WAKING_MS;
  // Still mid-sentence: from now on it's hearing you.
  if (Mic.isSpeaking()) buddyEl.classList.add('hearing');
  flare();
  window.buddy.prepare();
  setTimeout(updateMic, 0);
}

async function heard(wav, clip = {}) {
  const active = isActive();
  let raw = '';
  try {
    if (!active && clip.head) {
      // Only listening for the wake word: transcribe just the opening second
      // and a half (already done mid-speech by onHead, if it was long enough).
      // Speech that isn't for the buddy costs that little and no more.
      const early = earlyHead && earlyHead.id === clip.id ? earlyHead.text : null;
      earlyHead = null;
      const opening = await (early || window.buddy.transcribe(clip.head()));
      if (!splitWake(opening).woke) {
        state.wakingUntil = 0;
        return;
      }
      wakeUp();
      raw = clip.longerThanHead ? await window.buddy.transcribe(wav) : opening;
    } else {
      raw = await window.buddy.transcribe(wav);
    }
  } catch {
    return;
  }
  // The wake-up look has done its job: from here the request itself takes over.
  state.wakingUntil = 0;
  console.log(`[mic] heard: ${JSON.stringify(raw)}${state.listening ? ` (listening: ${state.listening})` : state.answering ? ' (answering)' : state.teaching ? ' (teaching)' : state.executing ? ' (jarvis working)' : ''}`);
  if (!raw) return;
  // "Stop" while Jarvis works stops him, even mid-question. Checked before the
  // echo filter: stopping must never be ignored.
  if (state.executing && /\b(stop|cancel|abort|halt|stand down|hold on|wait)\b/i.test(raw)) {
    showCaption(raw);
    stopJarvis();
    // "Wait, stop. I need you to get PianoScribe running": stop, then do that instead.
    const after = raw.replace(/^.*\b(stop|cancel|abort|halt|stand down|hold on|wait)\b[\s,.!?-]*/i, '').trim();
    const rest = splitWake(after).rest;
    if (rest.split(/\s+/).filter((w) => /[a-z0-9]{2}/i.test(w)).length >= 3) afterStop = rest.replace(/[.!?]+$/, '');
    return;
  }
  if (Date.now() - state.lastSpokenAt < 15000 && similar(raw, state.lastSpoken)) return;
  const { woke, agent: named, rest: text } = splitWake(raw);
  if (!hasWords(text) && (state.listening || state.answering || state.teaching)) return; // just "Hey Friday"

  if (state.listening) {
    finishListening(text);
    return;
  }
  if (state.answering) {
    answerInput.textContent = `${answerInput.textContent} ${text}`.trim();
    clearTimeout(autoSendTimer);
    // While they're typing, speech just adds to the box; Enter sends.
    if (state.typingAnswer) return;
    autoSendTimer = setTimeout(() => {
      if (state.answering && !Mic.isSpeaking()) sendAnswer(answerInput.textContent);
    }, 2000);
    return;
  }
  if (state.teaching) {
    showCaption(text);
    window.buddy.teachNarrate(text);
    return;
  }
  if (state.executing) return; // only "stop" (above) or answers count while he works
  // In a lesson, everything said is part of the conversation: questions,
  // "I'm not sure how", "I don't want to do that bit".
  if (state.guiding && !(woke && named && named !== state.agent)) {
    if (!hasWords(text) || NOT_WORDS.test(text)) return; // a cough or an "um" isn't something to answer
    showCaption(text);
    if (/^(?:ok(?:ay)?,? )?(?:stop|end|cancel|quit|exit)(?: (?:the|this) (?:lesson|tutorial|walkthrough))?(?: now| please)?[.!]?$/i.test(text)) {
      stopGuide();
      return;
    }
    window.buddy.guideSay(text);
    return;
  }
  // Background listening: only act when it starts with the wake word, or
  // straight after an exchange (a follow-up needs no wake word). While another
  // app is playing sound the mic can hear, a follow-up needs the name too:
  // otherwise a video talking would count as you.
  const otherSound = state.macAudio && !Mic.cancelsMacAudio();
  if (!woke && NOT_WORDS.test(text)) return; // noises and filler, not a follow-up
  if (!woke && convoOpen() && hasWords(text) && otherSound) {
    console.log('[mic] ignored (no name, and another app is playing sound)');
    return;
  }
  if ((state.wakeEnabled && woke) || (convoOpen() && hasWords(text))) {
    const rest = text;
    if (isClosing(rest)) {
      // Said to it ("Hey Friday, thanks"): a word back. Otherwise just rest.
      if (woke) say(state.agent === 'jarvis' ? 'At your service.' : 'Anytime!', { mood: 'happy', hold: 2500 });
      closeConvo();
      return;
    }
    if (state.busy) return;
    if (named) switchAgent(named);
    if (hasWords(rest)) {
      // "Hey Friday, how do I…": act on it straight away.
      if (state.guiding) stopGuide();
      state.listening = 'ask';
      finishListening(rest);
    } else {
      // Just "Hey Friday": listen for the request.
      startListening('ask');
      say((state.agents[state.agent] && state.agents[state.agent].wakeReply) || 'Yes?', { mood: 'happy', hold: 6000 });
    }
  }
}

// ---------- being interrupted, but only by something meaningful ----------
//
// Talking over Friday or Jarvis stops them, but a cough, a sneeze, a laugh or
// an "um" shouldn't. When a sound starts while they're talking, their voice
// dips instead of stopping; once there's more than half a second of it, what's
// been said so far is transcribed, and only real words (not their own voice
// echoing back) stop them. If it was just a noise, the voice comes back up.
const BARGE_MS = 600;
const NOT_WORDS = /^(?:[\s,.!?…*()[\]-]*(?:u+h+|u+m+|h+m+|m+|a+h+|o+h+|e+r+|erm|huh|ha(?:ha)*|he(?:he)*|achoo|ahem|bless you|excuse me|sorry|pardon|oops|cough(?:ing)?|sneez\w*|laugh\w*))*[\s,.!?…*()[\]-]*$/i;
const meaningful = (t) => hasWords(String(t || '')) && !NOT_WORDS.test(String(t)) && !similar(String(t), state.lastSpoken);
let barge = null; // { checking } while a sound is being checked during their speech

function duckVoice(on) {
  if (state.audio) state.audio.volume = on ? 0.3 : 1;
}

function bargeStart() {
  if (!buddyEl.classList.contains('talking')) return;
  barge = { checking: false };
  duckVoice(true);
}

function bargeProgress(ms) {
  const b = barge;
  if (!b || b.checking || ms < BARGE_MS) return;
  b.checking = true;
  window.buddy
    .transcribe(Mic.peek())
    .then((t) => {
      if (barge !== b) return;
      barge = null;
      if (meaningful(t)) stopSpeaking();
      else duckVoice(false);
    })
    .catch(() => {
      if (barge === b) duckVoice(false);
    });
}

function bargeEnd() {
  // A short sound that never reached the check: a cough or a click. Carry on.
  if (barge && !barge.checking) {
    barge = null;
    duckVoice(false);
  }
}

function updateMic() {
  // Typed mode (npm run text) never opens the microphone.
  const want = !state.micOff && (state.teaching || state.executing || Boolean(state.answering) || Boolean(state.listening) || state.wakeEnabled || (state.canHear && (state.guiding || convoOpen())));
  if (want && !Mic.isOn()) {
    Mic.start({
      // Quick requests end sooner; answers and narration allow slow, thoughtful speech.
      // Once it's heard its name, the end of the request comes quicker too.
      silenceMs: () => (state.listening || state.wakingUntil > Date.now() ? 1100 : 1600),
      // Short answers ("no", "yep") are fine; anything shorter is a cough or a click.
      minSpeechMs: () => (state.listening ? 200 : state.answering ? 320 : 450),
      gain: () => (buddyEl.classList.contains('talking') ? 2.5 : 1),
      onStart: () => {
        if (isActive()) active(); // talking to it (not just room noise while dormant)
        // You might be talking over it: dip its voice until we know it's words.
        bargeStart();
        clearTimeout(autoSendTimer);
        clearTimeout(listenTimeout);
        // Only shows it's hearing you when it's listening to respond; while it
        // just waits for its name, sounds in the room change nothing on screen.
        if (isActive() || state.wakingUntil > Date.now()) buddyEl.classList.add('hearing');
        window.buddy.teachSpeaking(true);
      },
      onProgress: bargeProgress,
      onEnd: () => {
        bargeEnd();
        buddyEl.classList.remove('hearing');
        window.buddy.teachSpeaking(false);
        if (state.listening) armListenTimeout(6000);
      },
      onLevel: (v) => {
        state.micLevel = v;
      },
      onUtterance: heard,
      onHead,
    }).then((ok) => {
      console.log(ok ? '[mic] listening' : '[mic] could not start');
      if (!ok) say("I can't hear you. Allow microphone access for me in System Settings.", { mood: 'worried' });
    });
  } else if (!want && Mic.isOn()) {
    Mic.stop();
    buddyEl.classList.remove('hearing');
  }
}
$('rec-finish').addEventListener('click', () => window.buddy.teachFinish());
recOff.addEventListener('click', () => window.buddy.teachOffRecord(!recEl.classList.contains('off')));

// ---------- ⌘⇧Space: just talk ----------

let listenTimeout = null;
const LISTEN_PROMPTS = { ask: 'Listening…', confirm: '', 'teach-name': 'What are you going to show me?' };

function startListening(mode) {
  active();
  if (state.listening) return cancelListening(); // second press cancels
  if (state.teaching) {
    showCaption("I'm already listening. Say \"I'm done\" when you've finished.");
    return;
  }
  if (state.answering || state.busy) return;
  if (mode === 'ask') window.buddy.prepare(); // read the screen while they talk
  if (state.executing) {
    showCaption('Jarvis is working. Say "stop" or press Esc to stop him.');
    return;
  }
  if (state.guiding) stopGuide();
  state.listening = mode;
  stopSpeaking();
  clearTimeout(state.sayTimer);
  if (LISTEN_PROMPTS[mode]) sayEl.textContent = LISTEN_PROMPTS[mode];
  bubble.classList.remove('hidden');
  buddyEl.classList.add('listening');
  flare();
  if (mode === 'teach-name') say(LISTEN_PROMPTS[mode], { mood: 'happy', hold: 15000 });
  updateMic();
  armListenTimeout(mode === 'teach-name' || mode === 'confirm' ? 12000 : 7000);
}

// Nothing (usable) said: give up quietly. Re-armed after every utterance, so a
// cough or a sound too short to count can never leave it listening forever.
function armListenTimeout(ms) {
  clearTimeout(listenTimeout);
  listenTimeout = setTimeout(() => {
    if (state.listening && !Mic.isSpeaking()) {
      cancelListening();
      say("I didn't catch that.", { speak: false, hold: 2500 });
    }
  }, ms);
}

function endListening() {
  state.listening = null;
  clearTimeout(listenTimeout);
  buddyEl.classList.remove('listening');
  setTimeout(updateMic, 0);
}

function cancelListening() {
  endListening();
  hideBubbleIfIdle();
}

// Spoken requests to start a lesson: "learn how to…", "watch me…", "let me show you…".
const TEACH_PHRASE = /^(?:ok(?:ay)?,? )?(?:(?:let me|i(?:'ll| will| want to)) )?(?:learn|watch me|record|teach you|show you)\b(?: how to| how i| this)?[\s:,.-]*(.*)$/i;

function finishListening(heardText) {
  const mode = state.listening;
  // Drop leading "um", "uh", "so", "okay"… and the wake word, so the request is recognised for what it is.
  const trimmed = heardText.replace(/^(?:\s*(?:um+|uh+|er+|erm|hmm+|so|okay|ok|right|hey)[\s,.-]+)+/i, '').trim() || heardText;
  const text = splitWake(trimmed).rest;
  if (!hasWords(text)) {
    endListening();
    hideBubbleIfIdle();
    return;
  }
  endListening();
  sayEl.textContent = `“${text}”`;
  if (mode === 'teach-name') {
    window.buddy.teachStart(text.replace(/[.!?]+$/, ''));
    return;
  }
  if (mode === 'confirm') {
    handleConfirm(text.replace(/[.!?]+$/, ''));
    return;
  }
  const teach = TEACH_PHRASE.exec(text.trim());
  if (teach) {
    window.buddy.teachStart(teach[1].replace(/[.!?]+$/, ''));
    return;
  }
  handleAsk(text.replace(/[.!?]+$/, ''));
}

window.buddy.on('listen', ({ mode }) => startListening(mode));

// ---------- click-through ----------

// The window ignores the mouse except over the buddy/bubble. With
// `forward: true` we still receive mousemove, so flip as the cursor enters.
document.addEventListener('mousemove', (e) => {
  const over = !!e.target.closest('.hit');
  if (over || e.target.closest('#shell')) active(); // hovering it wakes it
  const want = over || state.promptOpen || state.typingAnswer || state.guideTyping;
  if (want !== state.interactive) {
    state.interactive = want;
    window.buddy.setInteractive(want);
  }
});

// ---------- the corner island ----------
//
// In the island layout everything (status, speech, questions, Jarvis's task
// panel) sits in one black shape in the screen's corner. It's sized to what's
// in it, and the size is set explicitly so it animates as it grows and shrinks.
const shell = $('shell');
const shellIn = $('shell-in');

function fitShell() {
  if (!document.body.classList.contains('island')) {
    shell.classList.remove('open');
    shell.style.width = shell.style.height = '';
    return;
  }
  // Open while awake, or while anything in it is showing (a greeting, a question).
  const showing = [...shellIn.children].some((el) => el.id !== 'island-bar' && !el.classList.contains('hidden'));
  const open = !state.resting && (buddyEl.classList.contains('awake') || showing);
  shell.classList.toggle('open', open);
  // Closed, it's a small nub around the resting orb (sized in CSS).
  shell.style.width = open ? `${shellIn.offsetWidth}px` : '';
  shell.style.height = open ? `${shellIn.offsetHeight}px` : '';
  reportIsland(open);
}

// Tell main how big the island is (and whether it's waiting on an answer), so
// it can be kept clear of the cursor and the Dock. Only when it changes.
let lastBox = '';
function reportIsland(open) {
  const nub = parseFloat(getComputedStyle(shell).getPropertyValue('--nub')) || 46;
  const box = document.body.classList.contains('island')
    ? { w: open ? shellIn.offsetWidth : nub, h: open ? shellIn.offsetHeight : nub, interactive: Boolean(state.answering || state.promptOpen || state.typingAnswer || state.guideTyping || state.listening === 'confirm') }
    : { w: 0, h: 0, interactive: false };
  const key = JSON.stringify(box);
  if (key === lastBox) return;
  lastBox = key;
  window.buddy.islandBox(box);
}

// Slide clear of the Dock (main.js works out where): the island and the orb
// move together along the edge they're flush with, smoothly, and back again.
window.buddy.on('island-offset', ({ x, y, edge }) => {
  document.body.style.setProperty('--island-dx', `${x}px`);
  document.body.style.setProperty('--island-dy', `${y}px`);
  document.body.dataset.islandEdge = edge || '';
});
new ResizeObserver(fitShell).observe(shellIn);
// Things appearing or hiding (and waking or resting) change what it holds.
new MutationObserver(fitShell).observe(buddyEl, { attributes: true, attributeFilter: ['class'], subtree: true });

// ---------- wiring ----------

// Where the orb lives: in the notch (mode 'notch', with its place in the window)
// or the bottom-right corner. Everything that sits around the orb follows.
window.buddy.on('layout', (l) => {
  const inNotch = l && l.mode === 'notch' && l.notch;
  document.body.classList.toggle('notch', Boolean(inNotch));
  document.body.classList.toggle('island', Boolean(l && l.mode === 'island'));
  fitShell();
  for (const k of ['x', 'w', 'h']) {
    if (inNotch) document.body.style.setProperty(`--notch-${k}`, `${l.notch[k]}px`);
    else document.body.style.removeProperty(`--notch-${k}`);
  }
});

window.buddy.on('cursor', (p) => {
  state.cursor = p;
});
window.buddy.on('open-prompt', (p) => openPrompt(p || {}));
window.buddy.on('say', (m) => say(m.text, { mood: m.mood, hold: 2500, speak: m.speak !== false }));
function wakeRe(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  return new RegExp(`^\\s*(?:(?:hey|hi|okay|ok|yo)[\\s,.!]+)?${w.replace(/ph/g, '(?:ph|f)').replace(/ /g, '[\\s,]+')}\\b[\\s,.!?-]*`, 'i');
}

function setWake({ enabled, wakeWord }) {
  state.wakeEnabled = Boolean(enabled);
  if (wakeWord && state.agents.friday) state.agents.friday.wakeWord = wakeWord;
  state.wakeRes = Object.entries(state.agents).map(([agent, a]) => ({ agent, re: wakeRe(a.wakeWord) }));
  if (!state.wakeRes.length) state.wakeRes = [{ agent: 'friday', re: wakeRe(wakeWord || 'friday') }];
  setTimeout(updateMic, 0);
}

// ---------- who you're talking to ----------

const agentTag = $('agent-tag');
let agentTagTimer = null;

// Recolour the orb (CSS does the fade) and briefly show the agent's name.
function applyAgent(id, { show = true } = {}) {
  if (!state.agents[id]) return;
  const changed = id !== state.agent;
  state.agent = id;
  document.body.dataset.agent = id;
  const a = state.agents[id];
  orbEl.setAttribute('aria-label', `Ask ${a.name}`);
  askInput.placeholder = id === 'jarvis' ? 'What shall I do? e.g. “open the Q3 report”' : 'What should I find? e.g. “share”';
  if (changed && show) {
    agentTag.textContent = a.title;
    agentTag.classList.remove('hidden');
    agentTag.getAnimations().forEach((x) => x.cancel());
    agentTag.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    clearTimeout(agentTagTimer);
    agentTagTimer = setTimeout(() => agentTag.classList.add('hidden'), 2600);
    flare();
  }
}

// Switching here (wake word, "Jarvis, …" typed) tells main too.
function switchAgent(id) {
  if (!id || id === state.agent || !state.agents[id]) return;
  applyAgent(id);
  window.buddy.setAgent(id);
}

window.buddy.on('config', (c) => {
  state.micOff = Boolean(c.micOff);
  state.canHear = Boolean(c.canHear);
  state.voice = c.voice;
  state.pointerStyle = ['spark', 'highlight'].includes(c.pointerStyle) ? c.pointerStyle : 'mixed';
  state.agents = c.agents || {};
  applyAgent(c.agent || 'friday', { show: false });
  setWake({ enabled: c.wakeEnabled, wakeWord: c.wakeWord });
});
window.buddy.on('wake', setWake);
// What it pointed at moved, or went away (see trackPointed in main.js).
// A lesson started from the Skills hub ("Teach me"): show it like any answer.
window.buddy.on('show-result', (res) => runAsk((res && res.title) || '', () => Promise.resolve(res)));
window.buddy.on('repoint', ({ rect, label }) => {
  if (!state.pointerAt || state.guiding || state.executing) return;
  if (state.pointerMode === 'ring') {
    showSpot(rect, label);
    state.pointerAt = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    goHomeLater();
  } else queueGuide(() => pointTo(rect, label)).then(() => goHomeLater());
});
window.buddy.on('unpoint', () => {
  if (state.pointerAt && !state.guiding && !state.executing) queueGuide(goHome);
});
window.buddy.on('mac-audio', ({ playing }) => {
  state.macAudio = Boolean(playing);
});
window.buddy.on('agent', ({ agent }) => applyAgent(agent));

// Safety net: an unexpected error is logged, and the buddy stays usable.
window.addEventListener('error', (e) => console.error('[renderer]', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[renderer]', e.reason));
requestAnimationFrame(frame);
