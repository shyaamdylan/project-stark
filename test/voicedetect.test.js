const test = require('node:test');
const assert = require('node:assert');
const { isVoice } = require('../renderer/voice-detect');

const RATE = 16000;
const FRAME = 2048;
// A pseudo-random but repeatable noise source.
let seed = 7;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

// Typing: sharp clicks (a few ms, decaying) at a fast typist's pace.
function typing(frame, perSecond = 9, level = 0.5) {
  const buf = new Float32Array(FRAME);
  const gap = Math.round(RATE / perSecond);
  const offset = (frame * FRAME) % gap;
  for (let i = 0; i < FRAME; i++) {
    const since = (i + offset) % gap;
    if (since < 80) buf[i] = noise() * level * Math.exp(-since / 20);
  }
  return buf;
}

// Speech-like: a voiced tone with syllable-rate loudness, steady across the frame.
function speech(frame, level = 0.2) {
  const buf = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    const t = (frame * FRAME + i) / RATE;
    const syllable = 0.55 + 0.45 * Math.abs(Math.sin(Math.PI * 4 * t));
    buf[i] = level * syllable * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.15 * noise());
  }
  return buf;
}

test('typing, however loud, is not taken for someone talking', () => {
  for (let f = 0; f < 20; f++) assert.equal(isVoice(typing(f), 0.02), false, `frame ${f}`);
  for (let f = 0; f < 20; f++) assert.equal(isVoice(typing(f, 14, 0.9), 0.02), false, `fast typing frame ${f}`);
});

test('speech, even quiet, still is', () => {
  for (let f = 0; f < 20; f++) assert.equal(isVoice(speech(f), 0.02), true, `frame ${f}`);
  for (let f = 0; f < 20; f++) assert.equal(isVoice(speech(f, 0.05), 0.02), true, `quiet frame ${f}`);
});

test('talking while typing still counts as talking', () => {
  for (let f = 0; f < 20; f++) {
    const a = speech(f);
    const b = typing(f);
    const mix = a.map((v, i) => v + b[i]);
    assert.equal(isVoice(mix, 0.02), true, `frame ${f}`);
  }
});
