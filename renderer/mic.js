// Always-on microphone with a simple voice detector.
//
// Listens for loudness above the room's background noise. When you start
// talking it calls onStart (so the buddy can stop talking and listen); when
// you've been quiet for `silenceMs` it hands the whole utterance to
// onUtterance as a 16 kHz mono WAV. The pause allowed is generous on purpose,
// so you can speak slowly and think between phrases.

const Mic = (() => {
  const RATE = 16000;
  const FRAME = 2048; // samples per callback, ~128 ms
  const FRAME_MS = (FRAME / RATE) * 1000;
  const START_FRAMES = 2; // ~250 ms of sound before we call it speech
  const PRE_ROLL = 4; // keep ~0.5 s before speech starts so first words aren't clipped
  const MIN_SPEECH_MS = 450;
  const MAX_UTTERANCE_MS = 45000;

  let ctx = null;
  let stream = null;
  let proc = null;
  let opts = null;

  let floor = 0.01; // background noise level, adapts slowly
  let speaking = false;
  let loudRun = 0;
  let quietMs = 0;
  let speechMs = 0;
  let chunks = [];
  let preroll = [];

  function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  function encodeWav(frames) {
    const len = frames.reduce((n, f) => n + f.length, 0);
    const out = new DataView(new ArrayBuffer(44 + len * 2));
    const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    out.setUint32(4, 36 + len * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); // PCM
    out.setUint16(22, 1, true); // mono
    out.setUint32(24, RATE, true);
    out.setUint32(28, RATE * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    str(36, 'data');
    out.setUint32(40, len * 2, true);
    let o = 44;
    for (const f of frames) {
      for (let i = 0; i < f.length; i++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, f[i])) * 0x7fff, true);
    }
    return out.buffer;
  }

  function finish() {
    const frames = chunks;
    const ms = speechMs;
    speaking = false;
    chunks = [];
    speechMs = 0;
    quietMs = 0;
    if (opts.onEnd) opts.onEnd();
    if (ms >= MIN_SPEECH_MS) opts.onUtterance(encodeWav(frames));
  }

  function onAudio(e) {
    const buf = new Float32Array(e.inputBuffer.getChannelData(0));
    const level = rms(buf);
    // Higher bar while the buddy is talking, so its own voice doesn't count as you.
    const threshold = Math.max(0.012, floor * 2.8) * (opts.gain ? opts.gain() : 1);
    const loud = level > threshold;
    if (opts.onLevel) opts.onLevel(speaking ? Math.min(1, level * 12) : 0);

    if (!speaking) {
      // Track background noise only while nobody is talking.
      floor = loud ? floor : floor * 0.95 + level * 0.05;
      preroll.push(buf);
      if (preroll.length > PRE_ROLL) preroll.shift();
      loudRun = loud ? loudRun + 1 : 0;
      if (loudRun >= START_FRAMES) {
        speaking = true;
        chunks = preroll.slice();
        preroll = [];
        speechMs = loudRun * FRAME_MS;
        quietMs = 0;
        if (opts.onStart) opts.onStart();
      }
      return;
    }

    chunks.push(buf);
    if (loud) {
      speechMs += FRAME_MS;
      quietMs = 0;
    } else {
      quietMs += FRAME_MS;
    }
    const silence = typeof opts.silenceMs === 'function' ? opts.silenceMs() : opts.silenceMs;
    if (quietMs >= silence || chunks.length * FRAME_MS >= MAX_UTTERANCE_MS) finish();
  }

  async function start(o) {
    if (ctx) return true;
    opts = { silenceMs: 1600, ...o };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      console.error('[mic]', err);
      return false;
    }
    ctx = new AudioContext({ sampleRate: RATE });
    const src = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(FRAME, 1, 1);
    proc.onaudioprocess = onAudio;
    src.connect(proc);
    proc.connect(ctx.destination); // required for the processor to run; it outputs silence
    return true;
  }

  function stop() {
    if (!ctx) return;
    if (speaking) finish();
    proc.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    ctx = stream = proc = null;
    speaking = false;
    preroll = [];
  }

  return { start, stop, isOn: () => Boolean(ctx), isSpeaking: () => speaking };
})();
