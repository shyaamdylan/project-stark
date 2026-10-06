// Is the Mac playing sound from some other app (a video, music, a call)?
//
// While it is, the microphone can hear it, and it shouldn't count as someone
// talking to Friday or Jarvis. macOS's audio daemon holds a power assertion for
// each app playing audio ("Resources: audio-out", "Created for PID"), which
// `pmset -g assertions` lists without any special permission.

const { execFile } = require('child_process');

// From pmset's output: the PIDs playing audio, minus our own processes.
function otherAudioPids(text, ownPids = []) {
  const own = new Set(ownPids.map(Number));
  const pids = new Set();
  // Each assertion is a line naming it, then indented detail lines.
  const blocks = String(text || '').split(/\n(?=\s*pid \d+\()/);
  for (const b of blocks) {
    if (!/Resources:[^\n]*\baudio-out\b/.test(b)) continue;
    const m = /Created for PID:\s*(\d+)/.exec(b) || /pid (\d+)\(/.exec(b);
    const pid = m ? Number(m[1]) : null;
    if (pid && !own.has(pid)) pids.add(pid);
  }
  return [...pids];
}

function checkOtherAudio(ownPids) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'assertions'], { timeout: 2000 }, (err, out) => resolve(err ? false : otherAudioPids(out, ownPids).length > 0));
  });
}

module.exports = { otherAudioPids, checkOtherAudio };
