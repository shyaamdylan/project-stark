// Project Alpha — the buddy's behaviour (renderer process).
//
// The buddy is a glowing ball of energy that sits in the bottom-right corner.
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
  listening: null, // 'ask' or 'teach-name' while ⌘⇧Space is listening
  wakeEnabled: false,
  wakeRe: null, // matches "hey alpha", "ok alpha", "alpha," at the start of what you say
  micLevel: 0,
  lastSpoken: '',
  lastSpokenAt: 0,
  answering: null, // id of the question being answered
  pointerAt: null, // where the cursor is pointing, while it's out of the orb
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
  const reach = Math.min(14, d / 40);
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
  requestAnimationFrame(frame);
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
async function pointTo(rect, label, taps = 3) {
  const center = { x: rect.x + rect.w / 2, y: Math.max(4, rect.y + rect.h / 2) };
  if (state.pointerAt) {
    spot.classList.add('hidden');
    await cursorToSpark(state.pointerAt);
    await flySpark(state.pointerAt, center);
  } else {
    flare();
    state.exit = await squeezeOut(center);
    await flySpark(state.exit, center);
  }
  showSpot(rect, label);
  await sparkToCursor(center, taps);
  state.pointerAt = center;
}

// Bring the cursor home and melt it back into the orb.
async function goHome() {
  if (!state.pointerAt) return;
  const from = state.pointerAt;
  state.pointerAt = null;
  spot.classList.add('hidden');
  await cursorToSpark(from);
  await flySpark(from, state.exit);
  spark.classList.add('hidden');
  await absorb(state.exit);
  clearPointing();
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
  spotLabel.textContent = label;
  spot.classList.remove('hidden');
}

function clearPointing() {
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
  if (!state.promptOpen && !state.guiding && !state.answering && !state.listening) {
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
async function say(text, { mood, hold = 0, speak = true } = {}) {
  clearTimeout(state.sayTimer);
  stopSpeaking();
  const id = state.speechId;
  if (speak) {
    state.lastSpoken = text;
    state.lastSpokenAt = Date.now();
  }
  sayEl.textContent = text;
  showBubble();
  buddyEl.classList.remove('happy', 'worried');
  if (mood) buddyEl.classList.add(mood);

  const minMs = Math.max(1800, text.length * 55);
  const started = Date.now();
  if (speak && state.voice !== 'off') await voiceOut(text, id, mood);
  const elapsed = Date.now() - started;
  if (id !== state.speechId) return;

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
      const ok = await playAudio(`tts://speak/?text=${encodeURIComponent(text)}&mood=${encodeURIComponent(mood || '')}`, id);
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
    u.rate = 1.05;
    u.pitch = 1.25;
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
// skipped altogether. Keep the lists in step with main.js (made ahead there).

const FILLERS = ['Hmm…', 'Let me see…', 'One sec…', 'Okay, let me look…', 'Right…', 'Mm, let me check…', 'Just a moment…', 'Let me think…', 'Okay…', 'Mm-hmm, one second…'];
const ACKS = ['Got it.', 'Okay, makes sense.', 'Thanks, that helps.', 'Mm, okay.', 'Right, got it.', 'Ah, I see.', 'Okay, noted.', 'Perfect, thanks.'];

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
const nextFiller = phraseBag(FILLERS);
const nextAck = phraseBag(ACKS);

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
  const text = splitWake(input).rest;
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

async function runAsk(text, request = () => window.buddy.ask(text)) {
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

  if (res.guide) {
    // Steps arrive on their own as the user works (see 'guide-step').
    state.guiding = true;
    guideCount.textContent = 'Starting…';
    guideBar.classList.remove('hidden');
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
  await goHome();
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
  if (step.status === 'step') {
    guideCount.textContent = step.totalSteps ? `Step ${step.stepNo} of ${step.totalSteps}` : `Step ${step.stepNo}`;
    guideBar.classList.remove('hidden');
    // Speak while the cursor flies, so the two arrive together.
    if (step.say) {
      say(step.say, { mood: 'happy' });
      guideNote.textContent = step.note || '';
      guideNote.classList.toggle('hidden', !step.note);
    }
    if (step.rect) await pointTo(step.rect, step.label, Infinity);
    else if (!step.quietMove) await goHome();
    return;
  }

  // Finished, or can't go on.
  state.guiding = false;
  guideBar.classList.add('hidden');
  guideNote.classList.add('hidden');
  if (step.status === 'done') flare();
  await goHome();
  await say(step.say, { mood: step.status === 'done' ? 'happy' : 'worried', hold: 2000 });
}

function stopGuide() {
  if (!state.guiding) return;
  state.guiding = false;
  window.buddy.guideStop();
  stopSpeaking();
  guideBar.classList.add('hidden');
  guideNote.classList.add('hidden');
  nextStep = null;
  buddyEl.classList.remove('thinking');
  bubble.classList.add('hidden');
  sayEl.textContent = '';
  queueGuide(goHome);
}

window.buddy.on('guide-step', receiveStep);
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
});
$('guide-stop').addEventListener('click', stopGuide);

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

const PHASES = { live: 'Quick question', 'teach-back': 'Did I get it right?' };

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
  answerInput.dataset.placeholder = phase === 'teach-back' ? "Listening… say what's wrong, or just say yes" : 'Listening… just answer out loud';
  answerForm.classList.remove('hidden');
  updateMic();
  flare();
  say(text, { mood: 'happy' });
});

function sendAnswer(value) {
  if (!state.answering) return;
  const id = state.answering;
  state.answering = null;
  stopSpeaking();
  clearTimeout(autoSendTimer);
  answerForm.classList.add('hidden');
  bubble.classList.remove('wide');
  setTimeout(updateMic, 0);
  bubble.classList.add('hidden');
  sayEl.textContent = '';
  window.buddy.teachAnswer(id, value);
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

// "Hey Alpha, how do I…" -> { woke: true, rest: "how do I…" }. The wake word
// never goes further than this: not into requests, answers or narration.
function splitWake(text) {
  const m = state.wakeRe && state.wakeRe.exec(text);
  return m ? { woke: true, rest: text.slice(m[0].length).trim() } : { woke: false, rest: text.trim() };
}
const hasWords = (t) => t.replace(/[^a-z0-9]/gi, '').length >= 2;

async function heard(wav) {
  let raw = '';
  try {
    raw = await window.buddy.transcribe(wav);
  } catch {
    return;
  }
  if (!raw) return;
  if (Date.now() - state.lastSpokenAt < 15000 && similar(raw, state.lastSpoken)) return;
  const { woke, rest: text } = splitWake(raw);
  if (!hasWords(text) && (state.listening || state.answering || state.teaching)) return; // just "Hey Alpha"

  if (state.listening) {
    finishListening(text);
    return;
  }
  if (state.answering) {
    answerInput.textContent = `${answerInput.textContent} ${text}`.trim();
    clearTimeout(autoSendTimer);
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
  // Background listening: only act when it starts with the wake word.
  if (state.wakeEnabled && woke) {
    const rest = text;
    if (state.busy) return;
    if (hasWords(rest)) {
      // "Hey Alpha, how do I…": act on it straight away.
      if (state.guiding) stopGuide();
      state.listening = 'ask';
      finishListening(rest);
    } else {
      // Just "Hey Alpha": listen for the request.
      startListening('ask');
      say('Yes?', { mood: 'happy', hold: 6000 });
    }
  }
}

function updateMic() {
  const want = state.teaching || Boolean(state.answering) || Boolean(state.listening) || state.wakeEnabled;
  if (want && !Mic.isOn()) {
    Mic.start({
      // Quick requests end sooner; answers and narration allow slow, thoughtful speech.
      silenceMs: () => (state.listening ? 1100 : 1600),
      gain: () => (buddyEl.classList.contains('talking') ? 2.5 : 1),
      onStart: () => {
        // You started talking: the buddy stops and listens.
        if (buddyEl.classList.contains('talking')) stopSpeaking();
        clearTimeout(autoSendTimer);
        clearTimeout(listenTimeout);
        buddyEl.classList.add('hearing');
        window.buddy.teachSpeaking(true);
      },
      onEnd: () => {
        buddyEl.classList.remove('hearing');
        window.buddy.teachSpeaking(false);
      },
      onLevel: (v) => {
        state.micLevel = v;
      },
      onUtterance: heard,
    }).then((ok) => {
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
  if (state.listening) return cancelListening(); // second press cancels
  if (state.teaching) {
    showCaption("I'm already listening. Say \"I'm done\" when you've finished.");
    return;
  }
  if (state.answering || state.busy) return;
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
  // Nothing said at all: give up quietly.
  clearTimeout(listenTimeout);
  listenTimeout = setTimeout(() => {
    if (state.listening && !Mic.isSpeaking()) {
      cancelListening();
      say("I didn't hear anything. Press Command Shift Space and talk to me.", { speak: false });
    }
  }, mode === 'teach-name' || mode === 'confirm' ? 12000 : 7000);
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
  const want = over || state.promptOpen;
  if (want !== state.interactive) {
    state.interactive = want;
    window.buddy.setInteractive(want);
  }
});

// ---------- wiring ----------

window.buddy.on('cursor', (p) => {
  state.cursor = p;
});
window.buddy.on('open-prompt', (p) => openPrompt(p || {}));
window.buddy.on('say', (m) => say(m.text, { mood: m.mood, hold: 2500, speak: m.speak !== false }));
function setWake({ enabled, wakeWord }) {
  state.wakeEnabled = Boolean(enabled);
  const word = String(wakeWord || 'alpha').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  state.wakeRe = new RegExp(`^\\s*(?:(?:hey|hi|okay|ok|yo)[\\s,.!]+)?${word.replace(/ph/g, '(?:ph|f)').replace(/ /g, '[\\s,]+')}\\b[\\s,.!?-]*`, 'i');
  setTimeout(updateMic, 0);
}

window.buddy.on('config', (c) => {
  state.voice = c.voice;
  setWake(c);
});
window.buddy.on('wake', setWake);

// Safety net: an unexpected error is logged, and the buddy stays usable.
window.addEventListener('error', (e) => console.error('[renderer]', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[renderer]', e.reason));
requestAnimationFrame(frame);
