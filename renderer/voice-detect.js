// Is this slice of microphone audio someone talking, or just a sharp noise
// (typing, a click, a tap on the desk)?
//
// Loudness alone can't tell: a keystroke is as loud as a word. But a keystroke
// is a spike a few milliseconds long, while speech keeps going. So the ~128 ms
// slice is cut into 8 ms pieces, and it only counts as voice when most pieces
// are loud. A burst of typing has a few loud pieces with quiet between; speech
// fills the slice.

const VoiceDetect = (() => {
  const PIECE = 128; // samples: 8 ms at 16 kHz
  const FILLED = 0.45; // share of pieces that must be loud for it to be voice

  function rms(buf, from, to) {
    let s = 0;
    for (let i = from; i < to; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / Math.max(1, to - from));
  }

  // buf: Float32Array of samples; threshold: loudness that counts as sound.
  function isVoice(buf, threshold) {
    const pieces = Math.floor(buf.length / PIECE);
    if (!pieces) return rms(buf, 0, buf.length) > threshold;
    let loud = 0;
    for (let p = 0; p < pieces; p++) if (rms(buf, p * PIECE, (p + 1) * PIECE) > threshold * 0.7) loud++;
    return loud / pieces >= FILLED;
  }

  return { isVoice, PIECE, FILLED };
})();

if (typeof module !== 'undefined') module.exports = VoiceDetect;
