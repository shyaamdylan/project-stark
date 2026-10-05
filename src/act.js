// Jarvis's hands: click, type and press keys on the user's screen.
//
// Runs src/jxa/act.js with osascript. Everything here is deliberately small:
// the decisions about *whether* to act live in src/jarvis.js.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'jxa', 'act.js'), 'utf8');

// macOS virtual key codes, by the key names we record shortcuts with
// (uiohook-napi's names; see shortcutName in main.js).
const KEY_CODES = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15,
  Y: 16, T: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, Equal: 24, 9: 25, 7: 26, Minus: 27, 8: 28,
  0: 29, BracketRight: 30, O: 31, U: 32, BracketLeft: 33, I: 34, P: 35, Enter: 36, L: 37, J: 38,
  Quote: 39, K: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, N: 45, M: 46, Period: 47,
  Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53, NumpadEnter: 76,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  Home: 115, PageUp: 116, Delete: 117, End: 119, PageDown: 121,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

const MODS = { '⌃': 'control down', '⌥': 'option down', '⇧': 'shift down', '⌘': 'command down' };

// "⇧⌘S" -> { keyCode: 1, mods: ['shift down', 'command down'], name: 'S' }, or null if unknown.
function parseShortcut(keys) {
  const s = String(keys || '');
  const mods = [];
  let i = 0;
  while (i < s.length && MODS[s[i]]) mods.push(MODS[s[i++]]);
  const name = s.slice(i);
  if (!name || !(name in KEY_CODES)) return null;
  return { keyCode: KEY_CODES[name], mods, name };
}

function runOps(ops, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify({ ops })], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        if (/-1743|not allowed to send/i.test(msg)) return reject(Object.assign(new Error(msg), { code: 'AUTOMATION' }));
        if (/-1719|-25211|assistive access/i.test(msg)) return reject(Object.assign(new Error(msg), { code: 'ACCESSIBILITY' }));
        return reject(new Error(msg));
      }
      let out;
      try {
        out = JSON.parse(stdout.trim());
      } catch {
        return reject(new Error(`Could not parse act output: ${stdout.slice(0, 200)}`));
      }
      if (!out.ok) {
        const code = /-25211|assistive/i.test(out.error || '') ? 'ACCESSIBILITY' : undefined;
        return reject(Object.assign(new Error(out.error || 'action failed'), { code }));
      }
      resolve(true);
    });
  });
}

const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });

module.exports = {
  KEY_CODES,
  parseShortcut,
  click: (rect) => runOps([{ op: 'click', ...center(rect) }]),
  type: (text) => runOps([{ op: 'type', text: String(text) }], 30000),
  keys: (spec) => runOps([{ op: 'keys', keyCode: spec.keyCode, mods: spec.mods || [] }]),
  selectAll: () => runOps([{ op: 'keys', keyCode: KEY_CODES.A, mods: ['command down'] }]),
  escape: () => runOps([{ op: 'keys', keyCode: KEY_CODES.Escape, mods: [] }]),
  // lines < 0 scrolls down (reveals what's below point); > 0 scrolls up.
  scroll: (point, lines) => runOps([{ op: 'scroll', x: Math.round(point.x), y: Math.round(point.y), lines }]),
};
