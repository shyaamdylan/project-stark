// Where the orb lives: tucked into the MacBook's notch (like a Dynamic Island),
// or in the bottom-right corner on screens without one.
//
// macOS knows where the notch is (NSScreen's safe area and the menu bar areas
// either side of it); Electron doesn't, so we ask once through JXA.

const { execFile } = require('child_process');

const JXA = `ObjC.import('AppKit');
var s = $.NSScreen.screens, out = [];
for (var i = 0; i < s.count; i++) {
  var sc = s.objectAtIndex(i);
  var top = sc.safeAreaInsets.top;
  if (!(top > 0)) continue;
  var f = sc.frame, l = sc.auxiliaryTopLeftArea, r = sc.auxiliaryTopRightArea;
  out.push({ x: f.origin.x, w: f.size.width, left: l.origin.x + l.size.width, right: r.origin.x, h: top });
}
JSON.stringify(out);`;

// The notches on connected screens: [{ x, w (screen), left, right (notch edges), h }].
function findNotches() {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA], { timeout: 3000 }, (err, out) => {
      if (err) return resolve([]);
      try {
        const list = JSON.parse(String(out).trim());
        resolve(Array.isArray(list) ? list.filter((n) => n.right > n.left && n.h > 0) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

// How the overlay covers a display, and where the orb sits on it.
//   place  'notch' (always at the top centre, a notch drawn where there's none),
//          'corner', or 'auto' (the notch when this display has one)
// Returns { mode, area (screen rect for the window), notch ({ x, w, h } in the window) }.
function overlayLayout(display, notches = [], place = 'auto') {
  const b = display.bounds;
  const wa = display.workArea || b;
  const n = notches.find((x) => Math.abs(x.x - b.x) < 2 && Math.abs(x.w - b.width) < 2);
  const useNotch = place === 'notch' || (place === 'auto' && Boolean(n));
  if (!useNotch) return { mode: 'corner', area: { x: wa.x, y: wa.y, width: wa.width, height: wa.height }, notch: null };
  const menuBar = Math.max(24, wa.y - b.y);
  const notch = n ? { x: n.left - n.x, w: n.right - n.left, h: n.h } : { x: (b.width - 180) / 2, w: 180, h: menuBar };
  return { mode: 'notch', area: { x: b.x, y: b.y, width: b.width, height: b.height }, notch };
}

module.exports = { findNotches, overlayLayout };
