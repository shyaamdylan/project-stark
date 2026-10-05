// Where the orb lives:
//   island  a black shape flush in the screen's bottom-right corner, blending
//           into the frame, that grows to hold everything while it's active
//   notch   tucked into the MacBook's notch (like a Dynamic Island)
//   float   the orb floating just inside the bottom-right corner
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
//   place  'corner' (the island), 'float', 'notch' (always at the top centre, a
//          notch drawn where there's none), or 'auto' (the notch when this
//          display has one, else the island)
// Returns { mode, area (screen rect for the window), notch ({ x, w, h } in the window) }.
function overlayLayout(display, notches = [], place = 'corner') {
  const b = display.bounds;
  const wa = display.workArea || b;
  const whole = { x: b.x, y: b.y, width: b.width, height: b.height };
  const n = notches.find((x) => Math.abs(x.x - b.x) < 2 && Math.abs(x.w - b.width) < 2);
  const useNotch = place === 'notch' || (place === 'auto' && Boolean(n));
  if (place === 'float') return { mode: 'corner', area: { x: wa.x, y: wa.y, width: wa.width, height: wa.height }, notch: null };
  // The island sits flush in the screen's corner, so the overlay covers it all.
  if (!useNotch) return { mode: 'island', area: whole, notch: null };
  const menuBar = Math.max(24, wa.y - b.y);
  const notch = n ? { x: n.left - n.x, w: n.right - n.left, h: n.h } : { x: (b.width - 180) / 2, w: 180, h: menuBar };
  return { mode: 'notch', area: whole, notch };
}

module.exports = { findNotches, overlayLayout };
