// Keep the orb's window still in Mission Control, like the menu bar.
//
// When you open Mission Control (or swipe between Spaces), macOS shrinks and
// shuffles every window, the orb's overlay included, so it visibly flies off
// its corner. A window with the "stationary" collection behaviour is left
// alone, the way the menu bar and desktop are. Electron doesn't offer that
// setting, so we set it on the NSWindow ourselves through the Objective-C
// runtime, using koffi (a foreign-function library that ships prebuilt for
// macOS: no native build step).

// NSWindowCollectionBehavior flags we care about.
const STATIONARY = 1 << 4;

const withStationary = (behavior) => Number(behavior) | STATIONARY;

let objc = null; // { sel, send, sendGet, sendSet }
function runtime() {
  if (objc) return objc;
  const koffi = require('koffi');
  const lib = koffi.load('/usr/lib/libobjc.A.dylib');
  // Object and selector pointers are passed as 64-bit integers (macOS is 64-bit only).
  objc = {
    sel: lib.func('uint64 sel_registerName(const char *name)'),
    send: lib.func('objc_msgSend', 'uint64', ['uint64', 'uint64']),
    sendGet: lib.func('objc_msgSend', 'uint64', ['uint64', 'uint64']),
    sendSet: lib.func('objc_msgSend', 'void', ['uint64', 'uint64', 'uint64']),
  };
  return objc;
}

// Make an Electron BrowserWindow stationary. Returns true if it took.
function makeStationary(win) {
  if (process.platform !== 'darwin' || !win || win.isDestroyed()) return false;
  try {
    const o = runtime();
    // getNativeWindowHandle() is the window's NSView*; its -window is the NSWindow.
    const view = win.getNativeWindowHandle().readBigUInt64LE(0);
    const nsWindow = o.send(view, o.sel('window'));
    if (!nsWindow) return false;
    const before = o.sendGet(nsWindow, o.sel('collectionBehavior'));
    o.sendSet(nsWindow, o.sel('setCollectionBehavior:'), withStationary(before));
    const after = Number(o.sendGet(nsWindow, o.sel('collectionBehavior')));
    return (after & STATIONARY) !== 0;
  } catch (err) {
    console.warn('[overlay] could not keep the orb still in Mission Control:', err.message);
    return false;
  }
}

module.exports = { makeStationary, withStationary, STATIONARY };
