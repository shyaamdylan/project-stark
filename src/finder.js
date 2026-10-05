// Runs the JXA accessibility scan and returns its parsed result.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Read the script into memory so it works from inside an .asar archive.
const SCRIPT = fs.readFileSync(path.join(__dirname, 'jxa', 'list-elements.js'), 'utf8');

function runJxa(opts, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(opts)],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message);
          // -1743: user hasn't allowed us to control System Events.
          // -1719 / -25211: Accessibility permission missing.
          if (/-1743|not allowed to send/i.test(msg)) return reject(Object.assign(new Error(msg), { code: 'AUTOMATION' }));
          if (/-1719|-25211|assistive access/i.test(msg)) return reject(Object.assign(new Error(msg), { code: 'ACCESSIBILITY' }));
          return reject(new Error(msg));
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error(`Could not parse scan output: ${stdout.slice(0, 200)}`));
        }
      }
    );
  });
}

// Finding which apps own menu bar status icons means asking every running app
// (~2s). They rarely change, so remember the answer for a few minutes.
const STATUS_TTL_MS = 5 * 60 * 1000;
let statusCache = null; // { pids, at }

async function scanFrontApp({ activate = true } = {}) {
  const fresh = statusCache && Date.now() - statusCache.at < STATUS_TTL_MS;
  const result = await runJxa({
    excludePid: process.pid, activate, timeoutMs: 7000, maxElements: 8000,
    statusPids: fresh ? statusCache.pids : undefined,
  });
  if (!fresh && result.statusPids) statusCache = { pids: result.statusPids, at: Date.now() };
  return result;
}

// Just the front app, for watching someone work: skips the Dock, status icons
// and other apps' windows, so it can run every second.
function scanFrontWindow() {
  return runJxa({ excludePid: process.pid, frontOnly: true, timeoutMs: 2500, maxElements: 4000 }, 6000);
}

// A cheap summary of the screen's state (windows, focus, open menu). Compare two
// of these to tell whether the user has done something.
async function screenFingerprint() {
  const r = await runJxa({ excludePid: process.pid, fingerprint: true }, 5000);
  return r.fingerprint || '';
}

// Run one scan in the background so the first real request is fast.
function warmUp() {
  return scanFrontApp({ activate: false }).catch(() => {});
}

function refocusFrontApp() {
  return runJxa({ excludePid: process.pid, activateOnly: true }).catch(() => {});
}

module.exports = { scanFrontApp, scanFrontWindow, refocusFrontApp, warmUp, screenFingerprint };
