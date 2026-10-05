// JavaScript for Automation (JXA) — run with `osascript -l JavaScript`.
//
// Walks the accessibility tree of every app with a window on screen (ignoring
// Project Stark itself) and prints JSON describing every clickable-ish element
// that isn't hidden behind another window:
// { role, label, app, z, x, y, w, h } in global screen points, where z is the
// stacking order of its window (0 = front).
//
// The walk calls the native AXUIElement API directly instead of going through
// System Events. Each System Events request is an Apple Event (~30ms), and a
// real window has thousands of nested groups, so that route ran out of time
// before it reached most buttons. Here one call fetches every attribute of a node.
//
// argv[0] is a JSON options object:
//   excludePid   - our own PID, so we never inspect our overlay
//   timeoutMs    - stop walking after this long (big web pages are deep)
//   maxElements  - stop after visiting this many elements
//   activate     - bring the target app to the front when done
//   activateOnly - skip the scan, just re-focus the top app
//   statusPids   - apps known to own menu bar status icons (skips asking every app)
//   frontOnly    - only the front app's windows and menus (no Dock, status icons
//                  or other apps): much faster, for watching someone work
//   fingerprint  - skip the scan, just return a cheap summary of the screen's state
//                  (windows, focus, open menu) so callers can notice when it changes
//   (activate / activateOnly act on the app that owns the front window)

ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementCopyMultipleAttributeValues', ['int', ['id', 'id', 'int', 'id*']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);

var INTERESTING = {
  AXButton: 1, AXMenuButton: 1, AXPopUpButton: 1, AXCheckBox: 1, AXRadioButton: 1,
  AXLink: 1, AXMenuBarItem: 1, AXTab: 1, AXDisclosureTriangle: 1, AXComboBox: 1,
  AXTextField: 1, AXSearchField: 1, AXSlider: 1, AXIncrementor: 1, AXColorWell: 1, AXTextArea: 1,
  AXStaticText: 1, AXImage: 1, AXCell: 1, AXRow: 1, AXMenuItem: 1, AXDockItem: 1,
};
// Don't descend into these: their children are just decoration.
var LEAF = {
  AXButton: 1, AXMenuButton: 1, AXPopUpButton: 1, AXCheckBox: 1, AXRadioButton: 1,
  AXStaticText: 1, AXImage: 1, AXTextField: 1, AXSearchField: 1, AXSlider: 1,
  AXComboBox: 1, AXMenuBarItem: 1, AXDisclosureTriangle: 1, AXTextArea: 1,
  AXScrollBar: 1, AXValueIndicator: 1,
};
// AXMenu isn't a leaf: web apps draw dropdowns as role="menu" inside the page,
// and their items only show up if we look inside. Closed native menus report
// zero-size items, which the size check skips.

// Elements whose current value is worth reporting (what's typed, picked or ticked).
var HAS_VALUE = {
  AXTextField: 1, AXSearchField: 1, AXComboBox: 1, AXPopUpButton: 1, AXCheckBox: 1,
  AXRadioButton: 1, AXSlider: 1, AXTextArea: 1, AXIncrementor: 1,
};

// Order matters: node() below reads these by index.
var ATTRS = $(['AXRole', 'AXSubrole', 'AXTitle', 'AXDescription', 'AXValue', 'AXPosition', 'AXSize',
  'AXChildren', 'AXHelp', 'AXPlaceholderValue']);

// Visible app windows, front to back. Owner name/PID and bounds don't need
// Screen Recording permission.
function screenWindows(excludePid) {
  // 1 = OnScreenOnly, 16 = ExcludeDesktopElements, 0 = kCGNullWindowID.
  var ref = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.kCGWindowLayer !== 0) continue;
    if (w.kCGWindowOwnerPID === excludePid) continue;
    var b = w.kCGWindowBounds;
    if (!b || b.Width < 60 || b.Height < 60) continue;
    if (w.kCGWindowAlpha === 0) continue;
    out.push({ pid: w.kCGWindowOwnerPID, name: w.kCGWindowOwnerName, z: out.length, x: b.X, y: b.Y, w: b.Width, h: b.Height });
  }
  return out;
}

// Apps that may own menu bar status icons. Background-only processes
// (activation policy "prohibited") can't, and they're most of what's running.
function statusItemOwners(excludePid) {
  var running = $.NSWorkspace.sharedWorkspace.runningApplications;
  var out = [];
  for (var i = 0; i < running.count; i++) {
    var ra = running.objectAtIndex(i);
    if (ra.processIdentifier === excludePid || ra.activationPolicy === 2) continue;
    out.push({ pid: ra.processIdentifier, name: ObjC.unwrap(ra.localizedName) });
  }
  return out;
}

function safe(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return '';
  v = v.replace(/\s+/g, ' ').trim();
  return v.length > 120 ? v.slice(0, 120) : v;
}

function getAttr(el, name) {
  var r = Ref();
  var err = $.AXUIElementCopyAttributeValue(el, $(name), r);
  if (err === -25211) throw new Error('AX error -25211: assistive access not allowed');
  return err === 0 ? $(r[0]) : null;
}

function isNil(o) {
  return !o || safe(function () { return o.isNil(); }, true);
}

// Strings as-is, numbers (checkbox states, slider positions) as text, else ''.
function valueText(o) {
  if (isNil(o)) return '';
  if (o.isKindOfClass($.NSString)) return o.js;
  if (o.isKindOfClass($.NSNumber)) return String(o.js);
  return '';
}

// NSString -> JS string; anything else (numbers, AXValue errors, nil) -> ''.
function text(o) {
  if (isNil(o) || !o.isKindOfClass($.NSString)) return '';
  return o.js;
}

function list(o) {
  if (isNil(o) || !o.isKindOfClass($.NSArray)) return [];
  var out = [];
  for (var i = 0; i < o.count; i++) out.push(o.objectAtIndex(i));
  return out;
}

// AXValue structs aren't reachable through the bridge, but their description is
// "<AXValue 0x…> {value = x:10.000000 y:45.000000 type = kAXValueCGPointType}".
function pair(o, a, b) {
  if (isNil(o)) return null;
  var d = ObjC.unwrap(o.description) || '';
  var m = new RegExp(a + ':(-?[\\d.]+) ' + b + ':(-?[\\d.]+)').exec(d);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

function node(el) {
  var r = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, ATTRS, 0, r) !== 0) return null;
  var v = $(r[0]);
  if (isNil(v) || v.count < 10) return null;
  return {
    role: text(v.objectAtIndex(0)),
    subrole: text(v.objectAtIndex(1)),
    title: text(v.objectAtIndex(2)),
    desc: text(v.objectAtIndex(3)),
    value: valueText(v.objectAtIndex(4)),
    pos: pair(v.objectAtIndex(5), 'x', 'y'),
    size: pair(v.objectAtIndex(6), 'w', 'h'),
    children: v.objectAtIndex(7),
    help: text(v.objectAtIndex(8)),
    placeholder: text(v.objectAtIndex(9)),
  };
}

function intersects(x, y, w, h, clip) {
  if (!clip) return true;
  return x + w > clip.x && y + h > clip.y && x < clip.x + clip.w && y < clip.y + clip.h;
}

// Screen rectangles in the same top-left-origin coordinates the AX API uses.
function screenRects() {
  var scr = $.NSScreen.screens;
  if (!scr.count) return [];
  var mainH = scr.objectAtIndex(0).frame.size.height;
  var out = [];
  for (var i = 0; i < scr.count; i++) {
    var f = scr.objectAtIndex(i).frame;
    out.push({ x: f.origin.x, y: mainH - f.origin.y - f.size.height, w: f.size.width, h: f.size.height });
  }
  return out;
}

function onAnyScreen(x, y, w, h, screens) {
  var cx = x + w / 2, cy = y + h / 2;
  return screens.some(function (s) { return cx >= s.x && cy >= s.y && cx < s.x + s.w && cy < s.y + s.h; });
}

function dockList() {
  var running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.dock');
  if (!running.count) return null;
  var dock = $.AXUIElementCreateApplication(running.objectAtIndex(0).processIdentifier);
  $.AXUIElementSetMessagingTimeout(dock, 0.5);
  return list(safe(function () { return getAttr(dock, 'AXChildren'); }, null))[0] || null;
}

// Apps, folders and the Trash in the Dock. With auto-hide on, the icons sit
// just off screen until revealed; they're still listed, marked hidden.
function scanDock(out) {
  var dl = dockList();
  if (!dl) return;
  var screens = screenRects();
  list(safe(function () { return getAttr(dl, 'AXChildren'); }, null)).forEach(function (item) {
    var n = node(item);
    if (!n || n.role !== 'AXDockItem' || !n.title || !n.pos || !n.size) return;
    var el = { role: 'AXDockItem', label: str(n.title), app: 'Dock', z: 0, x: n.pos[0], y: n.pos[1], w: n.size[0], h: n.size[1] };
    if (!onAnyScreen(el.x, el.y, el.w, el.h, screens)) el.hidden = true;
    out.push(el);
  });
}

function isOpen(el) {
  var v = safe(function () { return getAttr(el, 'AXSelected'); }, null);
  return !isNil(v) && v.js === true;
}

// Closed menus report zero-size items, so only what's actually showing gets in.
function walkMenu(menu, appName, out, depth) {
  if (depth > 4) return;
  list(safe(function () { return getAttr(menu, 'AXChildren'); }, null)).forEach(function (mi) {
    var n = node(mi);
    if (!n || !n.pos || !n.size || n.size[0] < 2 || n.size[1] < 2) return;
    if (n.role === 'AXMenuItem' && n.title) {
      out.push({ role: 'AXMenuItem', label: str(n.title), app: appName, z: 0, x: n.pos[0], y: n.pos[1], w: n.size[0], h: n.size[1] });
    }
    list(n.children).forEach(function (sub) { walkMenu(sub, appName, out, depth + 1); });
  });
}

// Cheap description of what's on screen: which windows are where, what's focused,
// and which menu is open. Changes when the user clicks through a step.
function fingerprint(wins, front) {
  var parts = wins.map(function (w) { return [w.pid, Math.round(w.x / 4), Math.round(w.y / 4), Math.round(w.w / 4), Math.round(w.h / 4)].join(','); });
  var all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  all.forEach(function (w) {
    // Menus and popovers sit on high layers. Skip our own overlay and the system's cursor layers.
    if (w.kCGWindowLayer >= 101 && w.kCGWindowLayer < 1000 && w.kCGWindowOwnerPID !== front.excludePid) parts.push('L' + w.kCGWindowLayer + ':' + w.kCGWindowOwnerPID);
  });
  var fw = safe(function () { return getAttr(front.el, 'AXFocusedWindow'); }, null);
  if (!isNil(fw)) { var fwn = node(fw); if (fwn) parts.push('W:' + fwn.title); }
  var fe = safe(function () { return getAttr(front.el, 'AXFocusedUIElement'); }, null);
  if (!isNil(fe)) { var fen = node(fe); if (fen) parts.push('F:' + fen.role + ':' + fen.title + ':' + fen.desc); }
  list(safe(function () { return getAttr(getAttr(front.el, 'AXMenuBar'), 'AXChildren'); }, null)).forEach(function (item, i) {
    if (isOpen(item)) parts.push('M:' + i);
  });
  // An auto-hiding Dock sliding into view counts as a change.
  var first = list(safe(function () { return getAttr(dockList(), 'AXChildren'); }, null))[0];
  var fn = first && node(first);
  if (fn && fn.pos) parts.push('D:' + Math.round(fn.pos[0] / 8) + ',' + Math.round(fn.pos[1] / 8));
  return parts.join('|');
}

function intersect(a, b) {
  var x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x: x, y: y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

function activate(app, pid) {
  if ($.AXUIElementSetAttributeValue(app, $('AXFrontmost'), $.NSNumber.numberWithBool(true)) === 0) return;
  safe(function () {
    var procs = Application('System Events').processes.whose({ unixId: pid });
    if (procs.length) procs[0].frontmost = true;
  });
}

function run(argv) {
  var opts = {};
  try { opts = JSON.parse(argv[0] || '{}'); } catch (e) {}
  var excludePid = opts.excludePid || -1;
  var deadline = Date.now() + (opts.timeoutMs || 7000);
  var maxElements = opts.maxElements || 8000;

  if (!$.AXIsProcessTrusted()) throw new Error('AX error -25211: assistive access not allowed');

  var wins = screenWindows(excludePid);
  if (!wins.length) return JSON.stringify({ error: 'no-window', message: 'No app window found on screen.' });
  var owner = wins[0];

  var apps = [];
  var byPid = {};
  if (opts.frontOnly) wins = wins.filter(function (w) { return w.pid === owner.pid; });
  wins.forEach(function (w) {
    if (byPid[w.pid]) return;
    var el = $.AXUIElementCreateApplication(w.pid);
    $.AXUIElementSetMessagingTimeout(el, 1.0); // a hung app shouldn't stall the whole scan
    byPid[w.pid] = { pid: w.pid, name: w.name, el: el };
    apps.push(byPid[w.pid]);
  });
  var front = byPid[owner.pid];

  if (opts.activateOnly) {
    activate(front.el, owner.pid);
    return JSON.stringify({ app: owner.name, pid: owner.pid, elements: [] });
  }
  front.excludePid = excludePid;
  if (opts.fingerprint) return JSON.stringify({ app: owner.name, pid: owner.pid, fingerprint: fingerprint(wins, front) });

  // Electron apps only build their web accessibility tree when asked, and take
  // a moment to do it the first time. Chrome and Electron 12+ switch it on by
  // themselves once a node's role is read. We deliberately don't set
  // AXEnhancedUserInterface (VoiceOver's flag): it makes Chromium animate every
  // window move, which breaks window managers like Rectangle.
  var yes = $.NSNumber.numberWithBool(true);
  var waitForTree = false;
  apps.forEach(function (a) {
    var was = safe(function () { return getAttr(a.el, 'AXManualAccessibility'); }, null);
    var set = $.AXUIElementSetAttributeValue(a.el, $('AXManualAccessibility'), yes);
    if (set === 0 && (isNil(was) || !was.boolValue)) waitForTree = true;
  });
  if (waitForTree) delay(0.4);

  var elements = [];
  var visited = 0;
  var truncated = false;

  // Top-level menu bar items ("File", "Edit", ...). Only the front app's are on screen.
  list(safe(function () { return getAttr(getAttr(front.el, 'AXMenuBar'), 'AXChildren'); }, null)).forEach(function (item) {
    var n = node(item);
    if (!n || !n.title || !n.pos || !n.size) return;
    elements.push({ role: 'AXMenuBarItem', label: str(n.title), app: owner.name, z: 0, x: n.pos[0], y: n.pos[1], w: n.size[0], h: n.size[1] });
    // An open menu: its items, and any submenus open off it.
    if (isOpen(item)) list(n.children).forEach(function (m) { walkMenu(m, owner.name, elements, 0); });
  });
  // Context menus and pop-up menus hang straight off the app.
  list(safe(function () { return getAttr(front.el, 'AXChildren'); }, null)).forEach(function (c) {
    var n = node(c);
    if (n && n.role === 'AXMenu') walkMenu(c, owner.name, elements, 0);
  });

  // Status icons on the right of the menu bar (Wi-Fi, battery, other apps' extras).
  // Only ask apps that can own them, with a short timeout: one stuck background app shouldn't cost us a second.
  var owners = opts.frontOnly ? [] : opts.statusPids ? opts.statusPids.map(function (p) { return { pid: p, name: '' }; }) : statusItemOwners(excludePid);
  var statusPids = [];
  owners.forEach(function (o) {
    var axApp = $.AXUIElementCreateApplication(o.pid);
    $.AXUIElementSetMessagingTimeout(axApp, 0.1);
    var extras = safe(function () { return getAttr(axApp, 'AXExtrasMenuBar'); }, null);
    if (isNil(extras)) return;
    statusPids.push(o.pid);
    if (!o.name) o.name = safe(function () { return ObjC.unwrap($.NSRunningApplication.runningApplicationWithProcessIdentifier(o.pid).localizedName); }, '') || '';
    list(safe(function () { return getAttr(extras, 'AXChildren'); }, null)).forEach(function (item) {
      var n = node(item);
      if (!n || !n.pos || !n.size) return;
      var label = str(n.title) || str(n.desc) || str(n.help) || str(o.name);
      if (label) elements.push({ role: 'AXMenuBarItem', label: label, app: o.name, z: 0, x: n.pos[0], y: n.pos[1], w: n.size[0], h: n.size[1] });
    });
  });

  if (!opts.frontOnly) scanDock(elements);

  // Pair each AX window with its on-screen window (same app, same frame) so we
  // know its stacking order. Windows that don't pair up are minimised or on
  // another Space, so they're skipped.
  var queue = [];
  apps.forEach(function (a) {
    list(safe(function () { return getAttr(a.el, 'AXWindows'); }, null)).forEach(function (win) {
      var n = node(win);
      if (!n || !n.pos || !n.size) return;
      var cg = null;
      for (var i = 0; i < wins.length && !cg; i++) {
        var w = wins[i];
        if (w.pid === a.pid && Math.abs(w.x - n.pos[0]) < 2 && Math.abs(w.y - n.pos[1]) < 2 &&
            Math.abs(w.w - n.size[0]) < 2 && Math.abs(w.h - n.size[1]) < 2) cg = w;
      }
      if (!cg) return;
      list(n.children).forEach(function (c) { queue.push({ el: c, depth: 1, win: cg, clip: cg }); });
    });
  });
  // Front-most windows first, so if we run out of time it's the buried ones we miss.
  queue.sort(function (a, b) { return a.win.z - b.win.z; });

  // Is this point covered by a window stacked above window z?
  function hidden(x, y, z) {
    for (var i = 0; i < z; i++) {
      var w = wins[i];
      if (x >= w.x && y >= w.y && x < w.x + w.w && y < w.y + w.h) return true;
    }
    return false;
  }

  // Is this whole rect under a single window stacked above window z?
  function buried(x, y, w, h, z) {
    for (var i = 0; i < z; i++) {
      var o = wins[i];
      if (x >= o.x && y >= o.y && x + w <= o.x + o.w && y + h <= o.y + o.h) return true;
    }
    return false;
  }

  // Breadth-first walk (per window). Each node is clipped to the intersection of
  // its ancestors' frames, so content scrolled out of a list or panel is skipped
  // even when it's still inside the window's frame.
  for (var qi = 0; qi < queue.length; qi++) {
    if (Date.now() > deadline || visited > maxElements) { truncated = true; break; }
    var item = queue[qi];
    if (item.depth > 40) continue;
    var n = node(item.el);
    visited++;
    if (!n || !n.pos || !n.size) continue;
    var p = n.pos, s = n.size;
    if (s[0] < 2 || s[1] < 2) continue;
    if (!intersects(p[0], p[1], s[0], s[1], item.clip)) continue;
    if (buried(p[0], p[1], s[0], s[1], item.win.z)) continue;

    var role = n.role;
    if (n.subrole === 'AXSearchField') role = 'AXSearchField';
    if (n.subrole === 'AXTabButton') role = 'AXTab';

    if (INTERESTING[role] && !hidden(p[0] + s[0] / 2, p[1] + s[1] / 2, item.win.z)) {
      var label = str(n.title) || str(n.desc);
      if (!label && (role === 'AXStaticText' || role === 'AXLink' || role === 'AXCell')) label = str(n.value);
      if (!label && (role === 'AXButton' || role === 'AXLink' || role === 'AXMenuButton' || role === 'AXPopUpButton')) {
        // Unlabelled button: borrow text from inside it, then its tooltip.
        label = str(list(n.children).map(function (c) {
          var cn = node(c);
          return cn && cn.role === 'AXStaticText' ? cn.value || cn.title : '';
        }).join(' '));
        if (!label) label = str(n.help);
      }
      if (!label && (role === 'AXTextField' || role === 'AXSearchField' || role === 'AXComboBox' || role === 'AXTextArea')) label = str(n.placeholder);
      if (label) {
        var el = { role: role, label: label, app: item.win.name, z: item.win.z, x: p[0], y: p[1], w: s[0], h: s[1] };
        if (HAS_VALUE[role]) el.value = str(n.value);
        elements.push(el);
      }
    }

    if (!LEAF[role]) {
      // Tables and outlines can hold thousands of rows; only the visible ones matter.
      var kids = list(n.children);
      if (role === 'AXTable' || role === 'AXOutline') {
        var rows = list(safe(function () { return getAttr(item.el, 'AXVisibleRows'); }, null));
        if (rows.length) {
          // Keep column headers and other non-row children too.
          kids = kids.filter(function (c) { var cn = node(c); return cn && cn.role !== 'AXRow'; }).concat(rows);
        }
      }
      var clip = intersect(item.clip, { x: p[0], y: p[1], w: s[0], h: s[1] });
      for (var k = 0; k < kids.length; k++) queue.push({ el: kids[k], depth: item.depth + 1, win: item.win, clip: clip });
    }
  }

  if (opts.activate) activate(front.el, owner.pid);

  var fw = safe(function () { return getAttr(front.el, 'AXFocusedWindow'); }, null);
  var fwn = isNil(fw) ? null : node(fw);
  // Where the keyboard is: the field they're typing in and what it holds.
  var fe = safe(function () { return getAttr(front.el, 'AXFocusedUIElement'); }, null);
  var fen = isNil(fe) ? null : node(fe);
  var focused = fen ? { role: fen.role, label: str(fen.title || fen.desc || fen.placeholder || fen.help), value: fen.value ? str(fen.value) : '' } : null;

  return JSON.stringify({
    app: owner.name, pid: owner.pid, window: fwn ? fwn.title : '', focused: focused, apps: apps.map(function (a) { return a.name; }),
    statusPids: statusPids, visited: visited, truncated: truncated, elements: elements,
  });
}
