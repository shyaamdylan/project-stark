// Project Alpha — the buddy's behaviour (renderer process).

const $ = (id) => document.getElementById(id);
const buddyEl = $('buddy');
const bubble = $('bubble');
const sayEl = $('say');
const askForm = $('ask');
const askInput = $('ask-input');
const eyes = $('eyes');
const spot = $('spot');
const spotLabel = $('spot-label');
const pointer = $('pointer');
const stopBtn = $('stop');

const SIZE = { w: 140, h: 160, bottom: 4 };
const EYES = [
  { pupil: $('pupilL'), glint: $('glintL'), cx: 55, cy: 70 },
  { pupil: $('pupilR'), glint: $('glintR'), cx: 85, cy: 70 },
];
const ARMS = {
  left: { el: $('armL'), sx: 30, sy: 98, len: 40, rest: 115 },
  right: { el: $('armR'), sx: 110, sy: 98, len: 40, rest: 65 },
};
const WALK_SPEED = 650; // px per second

const state = {
  x: 0,
  cursor: { x: 0, y: 0 },
  cursorMovedAt: 0,
  lookOverride: null, // {x,y} while pointing at something
  busy: false,
  promptOpen: false,
  interactive: false,
  voice: 'system',
  audio: null,
  sayTimer: null,
  speechId: 0,
  runId: 0, // bumped by stop() so in-flight work is ignored
  question: false, // waiting for the user's answer to a yes/no/numbers question
  stopShown: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- position ----------

function homeX() {
  return window.innerWidth - SIZE.w - 40;
}
function buddyTop() {
  return window.innerHeight - SIZE.bottom - SIZE.h;
}
function setX(x, durationMs = 0) {
  state.x = clamp(x, 8, window.innerWidth - SIZE.w - 8);
  buddyEl.style.transitionDuration = `${durationMs}ms`;
  buddyEl.style.left = `${state.x}px`;
  placeBubble();
}

async function walkTo(x) {
  const target = clamp(x, 8, window.innerWidth - SIZE.w - 8);
  const dist = Math.abs(target - state.x);
  if (dist < 4) return;
  const ms = clamp((dist / WALK_SPEED) * 1000, 250, 1800);
  // Look where we're going.
  state.lookOverride = { x: target + SIZE.w / 2 + Math.sign(target - state.x) * 400, y: buddyTop() + 70 };
  buddyEl.classList.add('walking');
  setX(target, ms);
  await sleep(ms);
  buddyEl.classList.remove('walking');
  state.lookOverride = null;
}

// ---------- eyes ----------

function lookAt(p) {
  const top = buddyTop();
  for (const e of EYES) {
    const dx = p.x - (state.x + e.cx);
    const dy = p.y - (top + e.cy);
    const d = Math.hypot(dx, dy) || 1;
    const reach = Math.min(5, d / 30);
    const ox = (dx / d) * reach;
    const oy = (dy / d) * reach * 0.85;
    e.pupil.setAttribute('cx', e.cx + ox);
    e.pupil.setAttribute('cy', e.cy + oy);
    e.glint.setAttribute('cx', e.cx + 2 + ox * 0.8);
    e.glint.setAttribute('cy', e.cy - 3 + oy * 0.8);
  }
}

let idleGlance = null;
function eyeLoop() {
  let target = state.lookOverride || state.cursor;
  // Cursor parked for a while? Glance around now and then.
  if (!state.lookOverride && Date.now() - state.cursorMovedAt > 5000) {
    if (!idleGlance || Math.random() < 0.006) {
      idleGlance = { x: state.x + 70 + (Math.random() - 0.5) * 600, y: buddyTop() + (Math.random() - 0.7) * 300 };
    }
    target = idleGlance;
  } else {
    idleGlance = null;
  }
  lookAt(target);
  syncStopButton();
  requestAnimationFrame(eyeLoop);
}

async function blinkLoop() {
  for (;;) {
    await sleep(2200 + Math.random() * 3800);
    eyes.classList.add('blink');
    await sleep(110);
    eyes.classList.remove('blink');
    if (Math.random() < 0.2) {
      await sleep(140);
      eyes.classList.add('blink');
      await sleep(100);
      eyes.classList.remove('blink');
    }
  }
}

// ---------- arms + pointing ----------

function shoulder(arm) {
  return { x: state.x + arm.sx, y: buddyTop() + arm.sy };
}

function pointArmAt(p) {
  const side = p.x < state.x + SIZE.w / 2 ? 'left' : 'right';
  const arm = ARMS[side];
  const s = shoulder(arm);
  let deg = (Math.atan2(p.y - s.y, p.x - s.x) * 180) / Math.PI;
  // Keep each arm on its own side so it swings outward, not through the body.
  if (side === 'left') deg = deg < 0 ? deg + 360 : deg; // 90..270
  if (side === 'left') deg = clamp(deg, 100, 260);
  else deg = clamp(deg, -80, 80);
  arm.el.style.transform = `rotate(${deg}deg)`;
  const rad = (deg * Math.PI) / 180;
  return { x: s.x + Math.cos(rad) * arm.len, y: s.y + Math.sin(rad) * arm.len };
}

function restArms() {
  for (const arm of Object.values(ARMS)) arm.el.style.transform = `rotate(${arm.rest}deg)`;
}

// Clicky-style: a little blue cursor glides from the hand to the target.
async function flyPointer(from, to) {
  pointer.classList.remove('hidden');
  const tip = { x: 3.75, y: 2.5 }; // arrow tip inside the 30px svg
  const ctrl = { x: (from.x + to.x) / 2 + (to.y - from.y) * 0.25, y: Math.min(from.y, to.y) - 120 };
  const frames = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * ctrl.x + t ** 2 * to.x;
    const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * ctrl.y + t ** 2 * to.y;
    frames.push({ transform: `translate(${x - tip.x}px, ${y - tip.y}px) scale(${0.6 + 0.4 * t})` });
  }
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  await pointer.animate(frames, { duration: clamp(dist * 0.9, 450, 1100), easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' }).finished;
  // Little "tap" wiggle when it arrives.
  pointer.animate(
    [
      { transform: `translate(${to.x - tip.x}px, ${to.y - tip.y}px) scale(1)` },
      { transform: `translate(${to.x - tip.x + 4}px, ${to.y - tip.y + 4}px) scale(0.9)` },
      { transform: `translate(${to.x - tip.x}px, ${to.y - tip.y}px) scale(1)` },
    ],
    { duration: 600, iterations: 3, fill: 'forwards' }
  );
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
  pointer.getAnimations().forEach((a) => a.cancel());
  pointer.classList.add('hidden');
  restArms();
  state.lookOverride = null;
}

// ---------- speech bubble + voice ----------

function placeBubble() {
  const W = 250;
  const left = clamp(state.x + SIZE.w / 2 - W / 2, 8, window.innerWidth - W - 8);
  bubble.style.left = `${left - state.x}px`;
  bubble.style.setProperty('--tail', `${state.x + SIZE.w / 2 - left}px`);
}

function showBubble() {
  bubble.classList.remove('hidden');
  placeBubble();
}

function hideBubbleIfIdle() {
  if (!state.promptOpen) {
    bubble.classList.add('hidden');
    sayEl.textContent = '';
  }
}

function stopSpeaking() {
  state.speechId++;
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
  sayEl.textContent = text;
  showBubble();
  buddyEl.classList.remove('happy', 'worried');
  if (mood) buddyEl.classList.add(mood);

  const minMs = Math.max(1800, text.length * 55);
  const started = Date.now();
  if (speak && state.voice !== 'off') await voiceOut(text, id);
  const elapsed = Date.now() - started;
  if (id !== state.speechId) return;

  state.sayTimer = setTimeout(() => {
    if (id !== state.speechId) return;
    buddyEl.classList.remove('worried');
    hideBubbleIfIdle();
  }, Math.max(0, minMs - elapsed) + hold);
}

async function voiceOut(text, id) {
  buddyEl.classList.add('talking');
  try {
    if (state.voice === 'elevenlabs') {
      const { audio } = await window.buddy.speak(text);
      if (id !== state.speechId) return;
      if (audio) {
        await playAudio(`data:audio/mpeg;base64,${audio}`, id);
        return;
      }
    }
    await systemSpeak(text, id);
  } finally {
    if (id === state.speechId) buddyEl.classList.remove('talking');
  }
}

function playAudio(src, id) {
  return new Promise((resolve) => {
    const a = new Audio(src);
    state.audio = a;
    a.onended = a.onerror = () => resolve();
    a.play().catch(resolve);
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

// ---------- stop ----------

// The ■ button is there whenever the buddy is doing anything at all.
function syncStopButton() {
  const active = state.busy || state.question || state.promptOpen || buddyEl.classList.contains('talking');
  if (active !== state.stopShown) {
    state.stopShown = active;
    stopBtn.classList.toggle('hidden', !active);
  }
}

// Drop everything: speech, pointing, questions, half-finished requests.
function stop({ tellMain = true } = {}) {
  state.runId++;
  stopSpeaking();
  clearTimeout(state.sayTimer);
  clearPointing();
  buddyEl.classList.remove('thinking', 'excited', 'worried', 'walking');
  state.question = false;
  askInput.placeholder = DEFAULT_PLACEHOLDER;
  closePrompt({ refocus: false });
  state.busy = false;
  sayEl.textContent = '';
  bubble.classList.add('hidden');
  if (tellMain) window.buddy.stop();
  setX(parseFloat(getComputedStyle(buddyEl).left) || state.x); // freeze mid-walk
  setTimeout(() => {
    if (!state.busy) walkTo(homeX());
  }, 400);
}

const STOP_WORDS = /^\s*(?:(?:hey|ok|okay)\s+)?(?:(?:jarvis|friday)[\s,.!]*)?(?:stop(?: it| that| listening| talking| now)?|cancel|never ?mind|be quiet|shut up|shush|enough|go to sleep|abort)(?:[\s,]+(?:jarvis|friday))?[\s.!]*$/i;

stopBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  stop();
});

// ---------- asking ----------

const DEFAULT_PLACEHOLDER = askInput.placeholder;

function openPrompt() {
  if (state.busy) return;
  state.promptOpen = true;
  clearTimeout(state.sayTimer);
  stopSpeaking();
  sayEl.textContent = '';
  askForm.classList.remove('hidden');
  showBubble();
  askInput.value = '';
  setTimeout(() => askInput.focus(), 30);
  buddyEl.classList.add('excited');
  setTimeout(() => buddyEl.classList.remove('excited'), 1000);
}

function closePrompt({ refocus = true } = {}) {
  if (!state.promptOpen) return;
  // A pending question is answered "no" if the prompt is dismissed.
  if (state.question) return answerQuestion('no');
  state.promptOpen = false;
  askForm.classList.add('hidden');
  askInput.blur();
  if (!sayEl.textContent) bubble.classList.add('hidden');
  if (refocus) window.buddy.promptClosed();
}

// Main asked us something (e.g. "close these 3 windows?"): show it and wait.
function showQuestion(q) {
  state.question = true;
  clearPointing();
  buddyEl.classList.remove('thinking');
  say(q.text, { speak: false, hold: 600000 });
  if (state.voice !== 'off') voiceOut(q.speak || q.text, state.speechId);
  state.promptOpen = true;
  askForm.classList.remove('hidden');
  askInput.value = '';
  askInput.placeholder = 'yes, no, or numbers like “1 3”';
  showBubble();
  setTimeout(() => askInput.focus(), 30);
}

function answerQuestion(text) {
  state.question = false;
  askInput.placeholder = DEFAULT_PLACEHOLDER;
  state.promptOpen = false;
  askForm.classList.add('hidden');
  askInput.blur();
  stopSpeaking();
  window.buddy.answer(text);
  window.buddy.promptClosed(); // hand focus and the mouse back to your apps
  state.interactive = false;
  buddyEl.classList.add('thinking');
  say('Okay…', { speak: false });
}

async function handleAsk(text) {
  if (STOP_WORDS.test(text)) return stop();
  const myRun = ++state.runId;
  state.busy = true;
  closePrompt({ refocus: false });
  window.buddy.setInteractive(false);
  buddyEl.classList.add('thinking');
  say('Hmm, let me look…', { speak: false });

  let res;
  try {
    res = await window.buddy.ask(text);
  } catch (e) {
    res = { ok: false, say: 'Oops, something went wrong.' };
  }
  if (myRun !== state.runId) return; // stopped while we were working
  buddyEl.classList.remove('thinking');
  if (res.kind === 'stopped') return stop({ tellMain: false });

  // Organising, switching, opening: nothing to point at, just report.
  if (res.ok && res.kind === 'done') {
    await say(res.say, { mood: res.mood || 'happy', hold: 1500 });
    if (myRun === state.runId) state.busy = false;
    return;
  }

  if (!res.ok) {
    await say(res.say, { mood: 'worried', hold: 1500 });
    if (myRun === state.runId) state.busy = false;
    return;
  }

  const r = res.rect;
  const center = { x: r.x + r.w / 2, y: Math.max(4, r.y + r.h / 2) };

  // Walk to stand a little beside the target, then point.
  const side = center.x > window.innerWidth / 2 ? -1 : 1;
  const standX = center.x - SIZE.w / 2 + side * 110;
  sayEl.textContent = '';
  bubble.classList.add('hidden');
  await walkTo(standX);
  if (myRun !== state.runId) return;

  state.lookOverride = center;
  const hand = pointArmAt(center);
  await sleep(350);
  buddyEl.classList.add('excited');
  showSpot(r, res.label);
  const flight = flyPointer(hand, center);
  await say(res.say, { mood: 'happy', hold: 2500 });
  await flight;
  await sleep(1500);
  if (myRun !== state.runId) return;

  clearPointing();
  buddyEl.classList.remove('excited');
  hideBubbleIfIdle();
  await sleep(300);
  await walkTo(homeX());
  if (myRun === state.runId) state.busy = false;
}

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = askInput.value.trim();
  if (state.question) return STOP_WORDS.test(text) ? stop() : answerQuestion(text);
  if (text) handleAsk(text);
});

askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.question) answerQuestion('no');
    else if (state.busy) stop();
    else closePrompt();
  }
});

askInput.addEventListener('blur', () => {
  // Clicked away into another app: close quietly.
  setTimeout(() => {
    if (state.promptOpen && !state.question && document.activeElement !== askInput && !state.busy) closePrompt({ refocus: false });
  }, 150);
});

$('char').addEventListener('click', () => {
  if (state.promptOpen) return closePrompt();
  window.buddy.openPrompt();
});

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
  if (p.x !== state.cursor.x || p.y !== state.cursor.y) state.cursorMovedAt = Date.now();
  state.cursor = p;
});
window.buddy.on('open-prompt', openPrompt);
window.buddy.on('question', showQuestion);
window.buddy.on('stopped', () => stop({ tellMain: false }));
window.buddy.on('say', (m) => say(m.text, { mood: m.mood, hold: 2500 }));
window.buddy.on('config', (c) => {
  state.voice = c.voice;
});
window.addEventListener('resize', () => {
  if (!state.busy) setX(homeX());
});

setX(homeX());
restArms();
requestAnimationFrame(eyeLoop);
blinkLoop();
