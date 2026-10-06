// Always-on microphone with a simple voice detector.
//
// Listens for loudness above the room's background noise. When you start
// talking it calls onStart (so the buddy can stop talking and listen); when
// you've been quiet for `silenceMs` it hands the whole utterance to
// onUtterance as a 16 kHz mono WAV. The pause allowed is generous on purpose,
// so you can speak slowly and think between phrases.
//
// onHead gets the opening second and a half while you're still talking, so a
// wake word can be spotted (and the orb wake up) without waiting for the end.

const Mic = (() => {
  const RATE = 16000;
  const FRAME = 2048; // samples per callback, ~128 ms
  const FRAME_MS = (FRAME / RATE) * 1000;
  const START_FRAMES = 2; // ~250 ms of sound before we call it speech
  const PRE_ROLL = 4; // keep ~0.5 s before speech starts so first words aren't clipped
  const MIN_SPEECH_MS = 450;
  const MAX_UTTERANCE_MS = 45000;
  const HEAD_MS = 1600; // enough for "Hey Friday" with a little lead-in

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
  let utterance = 0; // which utterance this is, so onHead and onUtterance can be matched
  let headSent = false;
  let echoReported = null; // which echo cancellation we got, logged once
  const HEAD_FRAMES = Math.ceil(HEAD_MS / FRAME_MS);

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
    // Short answers ("no", "yep") are allowed when we're waiting for one.
    const min = opts.minSpeechMs ? opts.minSpeechMs() : MIN_SPEECH_MS;
    if (ms < min) return;
    // The opening second and a half, for a cheap "was that for me?" check:
    // the wake word always comes first, so there's no need to send the rest.
    const headFrames = frames.slice(0, HEAD_FRAMES);
    opts.onUtterance(encodeWav(frames), {
      id: utterance,
      head: () => encodeWav(headFrames),
      longerThanHead: frames.length > headFrames.length,
    });
  }

  function onAudio(e) {
    const buf = new Float32Array(e.inputBuffer.getChannelData(0));
    const level = rms(buf);
    // Higher bar while the buddy is talking, so its own voice doesn't count as you.
    const threshold = Math.max(0.012, floor * 2.8) * (opts.gain ? opts.gain() : 1);
    // Loud and sustained like a voice, not a keystroke or a click (voice-detect.js).
    const loud = level > threshold && VoiceDetect.isVoice(buf, threshold);
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
        utterance++;
        headSent = false;
        if (opts.onStart) opts.onStart();
      }
      return;
    }

    chunks.push(buf);
    if (!headSent && chunks.length >= HEAD_FRAMES && opts.onHead) {
      headSent = true;
      opts.onHead(encodeWav(chunks.slice(0, HEAD_FRAMES)), utterance);
    }
    if (loud) {
      speechMs += FRAME_MS;
      quietMs = 0;
    } else {
      quietMs += FRAME_MS;
    }
    if (opts.onProgress) opts.onProgress(speechMs);
    const silence = typeof opts.silenceMs === 'function' ? opts.silenceMs() : opts.silenceMs;
    if (quietMs >= silence || chunks.length * FRAME_MS >= MAX_UTTERANCE_MS) finish();
  }

  async function start(o) {
    if (ctx) return true;
    opts = { silenceMs: 1600, ...o };
    // Only you should count as speech, not the Mac's own sound (a video, music,
    // a call). echoCancellation "all" cancels everything the Mac plays, using
    // macOS's own voice processing (as FaceTime does); plain echo cancellation
    // only removes what this app plays (the buddy's voice). Ask for "all" and
    // fall back where it isn't supported.
    const base = { noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: { exact: 'all' } } });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: true } });
      }
    } catch (err) {
      console.error('[mic]', err);
      return false;
    }
    const ec = stream.getAudioTracks()[0] && stream.getAudioTracks()[0].getSettings().echoCancellation;
    if (ec !== echoReported) {
      echoReported = ec;
      console.log(ec === 'all' ? "[mic] ignoring the Mac's own audio (system echo cancellation on)" : "[mic] system echo cancellation isn't available here: sound playing on the Mac can be heard as speech");
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

  // cancelsMacAudio: the Mac's own sound is already removed from what we hear.
  // peek: what's been said so far in the utterance in progress, as a WAV.
  return { start, stop, isOn: () => Boolean(ctx), isSpeaking: () => speaking, cancelsMacAudio: () => echoReported === 'all', peek: () => encodeWav(chunks) };
})();
