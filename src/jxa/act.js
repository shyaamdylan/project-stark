// JavaScript for Automation (JXA) — run with `osascript -l JavaScript`.
//
// Jarvis's hands: performs a short list of input actions on screen.
//
// argv[0] is a JSON object { ops: [...] }, each op one of:
//   { op: 'click', x, y }                         left click at a global screen point
//   { op: 'type', text }                          type text into whatever has focus
//   { op: 'keys', keyCode, mods: ['command down'] } press a key with modifiers
//   { op: 'scroll', x, y, lines }                 scroll under that point (negative = down)
//
// Clicks and scrolls are posted as CoreGraphics events (needs Accessibility
// permission, which the scanner already asks for). Typing and keys go through
// System Events. Prints { ok: true } or { ok: false, error }.

ObjC.import('Foundation');
ObjC.import('CoreGraphics');
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
ObjC.bindFunction('CGEventCreateScrollWheelEvent', ['id', ['id', 'uint32', 'uint32', 'int32']]);

// CGEventType and friends, as numbers: the constants aren't always bridged.
var MOUSE_MOVED = 5;
var LEFT_DOWN = 1;
var LEFT_UP = 2;
var LEFT_BUTTON = 0;
var HID_TAP = 0;

function mouse(type, x, y) {
  var e = $.CGEventCreateMouseEvent(null, type, { x: x, y: y }, LEFT_BUTTON);
  $.CGEventPost(HID_TAP, e);
}

function click(x, y) {
  mouse(MOUSE_MOVED, x, y);
  delay(0.06);
  mouse(LEFT_DOWN, x, y);
  delay(0.05);
  mouse(LEFT_UP, x, y);
}

var SCROLL_UNIT_LINE = 1;

// Scroll wheel events go to whatever's under the pointer, like a real trackpad
// swipe, so move there first. lines is signed the way a trackpad feels:
// positive scrolls content up (reveals what's below), negative scrolls down.
function scroll(x, y, lines) {
  mouse(MOUSE_MOVED, x, y);
  delay(0.03);
  var e = $.CGEventCreateScrollWheelEvent(null, SCROLL_UNIT_LINE, 1, lines);
  if (e) $.CGEventPost(HID_TAP, e);
}

function run(argv) {
  var opts = JSON.parse(argv[0] || '{}');
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ ok: false, error: 'AX error -25211: assistive access not allowed' });
  var se = null;
  var events = function () {
    if (!se) se = Application('System Events');
    return se;
  };
  var ops = opts.ops || [];
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i];
    if (o.op === 'click') {
      if (typeof o.x !== 'number' || typeof o.y !== 'number') return JSON.stringify({ ok: false, error: 'bad click point' });
      click(o.x, o.y);
    } else if (o.op === 'type') {
      events().keystroke(String(o.text || ''));
    } else if (o.op === 'keys') {
      if (typeof o.keyCode !== 'number') return JSON.stringify({ ok: false, error: 'bad key' });
      if (o.mods && o.mods.length) events().keyCode(o.keyCode, { using: o.mods });
      else events().keyCode(o.keyCode);
    } else if (o.op === 'scroll') {
      if (typeof o.x !== 'number' || typeof o.y !== 'number' || typeof o.lines !== 'number') return JSON.stringify({ ok: false, error: 'bad scroll' });
      scroll(o.x, o.y, o.lines);
    } else {
      return JSON.stringify({ ok: false, error: 'unknown op ' + o.op });
    }
    delay(0.08);
  }
  return JSON.stringify({ ok: true });
}
