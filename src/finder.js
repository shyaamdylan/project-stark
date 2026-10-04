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

function scanFrontApp({ activate = true } = {}) {
  return runJxa({ excludePid: process.pid, activate, timeoutMs: 7000, maxElements: 3000 });
}

function refocusFrontApp() {
  return runJxa({ excludePid: process.pid, activateOnly: true }).catch(() => {});
}

module.exports = { scanFrontApp, refocusFrontApp };
