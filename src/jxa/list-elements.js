// JavaScript for Automation (JXA) — run with `osascript -l JavaScript`.
//
// Finds the app whose window is on top (ignoring Project Alpha itself), walks its
// accessibility tree via System Events, and prints JSON describing every
// clickable-ish element: { role, label, x, y, w, h } in global screen points.
//
// argv[0] is a JSON options object:
//   excludePid   - our own PID, so we never inspect our overlay
//   timeoutMs    - stop walking after this long (big web pages are deep)
//   maxElements  - stop after visiting this many elements
//   activate     - bring the target app to the front when done
//   activateOnly - skip the scan, just re-focus the top app

ObjC.import('CoreGraphics');

var INTERESTING = {
  AXButton: 1, AXMenuButton: 1, AXPopUpButton: 1, AXCheckBox: 1, AXRadioButton: 1,
  AXLink: 1, AXMenuBarItem: 1, AXTab: 1, AXDisclosureTriangle: 1, AXComboBox: 1,
  AXTextField: 1, AXSearchField: 1, AXSlider: 1, AXIncrementor: 1, AXColorWell: 1,
  AXStaticText: 1, AXImage: 1, AXCell: 1, AXRow: 1,
};
// Don't descend into these: their children are just decoration.
var LEAF = {
  AXButton: 1, AXMenuButton: 1, AXPopUpButton: 1, AXCheckBox: 1, AXRadioButton: 1,
  AXStaticText: 1, AXImage: 1, AXTextField: 1, AXSearchField: 1, AXSlider: 1,
  AXComboBox: 1, AXMenuBarItem: 1, AXDisclosureTriangle: 1, AXTextArea: 1,
  AXScrollBar: 1, AXValueIndicator: 1, AXMenu: 1,
};

function frontWindowOwner(excludePid) {
  // 1 = OnScreenOnly, 16 = ExcludeDesktopElements, 0 = kCGNullWindowID.
  // Returned front-to-back. Owner name/PID don't need Screen Recording permission.
  var ref = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.kCGWindowLayer !== 0) continue;
    if (w.kCGWindowOwnerPID === excludePid) continue;
    var b = w.kCGWindowBounds;
    if (!b || b.Width < 60 || b.Height < 60) continue;
    if (w.kCGWindowAlpha === 0) continue;
    return { pid: w.kCGWindowOwnerPID, name: w.kCGWindowOwnerName };
  }
  return null;
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

// Fetch a property for every child in ONE Apple Event when possible; fall back
// to one event per child if any child chokes on the batched request.
function batch(coll, refs, prop) {
  var all = safe(function () { return coll[prop](); }, null);
  if (all && all.length === refs.length) return all;
  return refs.map(function (r) { return safe(function () { return r[prop](); }, null); });
}

function intersects(x, y, w, h, clip) {
  if (!clip) return true;
  return x + w > clip.x && y + h > clip.y && x < clip.x + clip.w && y < clip.y + clip.h;
}

function run(argv) {
  var opts = {};
  try { opts = JSON.parse(argv[0] || '{}'); } catch (e) {}
  var excludePid = opts.excludePid || -1;
  var deadline = Date.now() + (opts.timeoutMs || 7000);
  var maxElements = opts.maxElements || 3000;

  var owner = frontWindowOwner(excludePid);
  if (!owner) return JSON.stringify({ error: 'no-window', message: 'No app window found on screen.' });

  var se = Application('System Events');
  var procs = se.processes.whose({ unixId: owner.pid });
  if (procs.length === 0) return JSON.stringify({ error: 'no-process', app: owner.name });
  var proc = procs[0];

  if (opts.activateOnly) {
    safe(function () { proc.frontmost = true; });
    return JSON.stringify({ app: owner.name, pid: owner.pid, elements: [] });
  }

  // Chromium/Electron apps only build their web accessibility tree when asked.
  safe(function () { proc.attributes['AXEnhancedUserInterface'].value = true; });
  safe(function () { proc.attributes['AXManualAccessibility'].value = true; });

  var elements = [];
  var visited = 0;
  var truncated = false;

  // Top-level menu bar items ("File", "Edit", ...).
  safe(function () {
    var coll = proc.menuBars[0].menuBarItems;
    var refs = coll();
    var names = batch(coll, refs, 'name');
    var pos = batch(coll, refs, 'position');
    var size = batch(coll, refs, 'size');
    for (var i = 0; i < refs.length; i++) {
      if (!names[i] || !pos[i] || !size[i]) continue;
      elements.push({ role: 'AXMenuBarItem', label: str(names[i]), x: pos[i][0], y: pos[i][1], w: size[i][0], h: size[i][1] });
    }
  });

  // Breadth-first walk of each window, clipped to the window's frame so we skip
  // content that is scrolled out of view.
  var queue = [];
  var winRefs = safe(function () { return proc.windows(); }, []);
  for (var wi = 0; wi < winRefs.length; wi++) {
    var wp = safe(function () { return winRefs[wi].position(); }, null);
    var ws = safe(function () { return winRefs[wi].size(); }, null);
    if (!wp || !ws) continue;
    queue.push({ el: winRefs[wi], depth: 0, clip: { x: wp[0], y: wp[1], w: ws[0], h: ws[1] } });
  }

  while (queue.length) {
    if (Date.now() > deadline || visited > maxElements) { truncated = true; break; }
    var item = queue.shift();
    if (item.depth > 30) continue;

    var coll = item.el.uiElements;
    var refs = safe(function () { return coll(); }, []);
    if (!refs.length) continue;
    visited += refs.length;

    var roles = batch(coll, refs, 'role');
    var names = batch(coll, refs, 'name');
    var descs = batch(coll, refs, 'description');
    var pos = batch(coll, refs, 'position');
    var size = batch(coll, refs, 'size');
    var values = safe(function () { return coll.value(); }, null) || [];
    var subroles = safe(function () { return coll.subrole(); }, null) || [];

    for (var i = 0; i < refs.length; i++) {
      var role = roles[i] || '';
      var p = pos[i], s = size[i];
      if (!p || !s || s[0] < 2 || s[1] < 2) continue;
      if (!intersects(p[0], p[1], s[0], s[1], item.clip)) continue;

      if (subroles[i] === 'AXSearchField') role = 'AXSearchField';
      if (subroles[i] === 'AXTabButton') role = 'AXTab';

      if (INTERESTING[role]) {
        var label = str(names[i]) || str(descs[i]);
        if (!label && (role === 'AXStaticText' || role === 'AXLink' || role === 'AXCell')) label = str(values[i]);
        if (!label && (role === 'AXButton' || role === 'AXLink' || role === 'AXMenuButton' || role === 'AXPopUpButton')) {
          // Unlabelled button: borrow text from inside it, then its tooltip.
          label = str(safe(function () { return refs[i].staticTexts.value().join(' '); }, ''));
          if (!label) label = str(safe(function () { return refs[i].help(); }, ''));
        }
        if (!label && (role === 'AXTextField' || role === 'AXSearchField' || role === 'AXComboBox')) {
          label = str(safe(function () { return refs[i].attributes['AXPlaceholderValue'].value(); }, ''));
        }
        if (label) elements.push({ role: role, label: label, x: p[0], y: p[1], w: s[0], h: s[1] });
      }

      if (!LEAF[role]) queue.push({ el: refs[i], depth: item.depth + 1, clip: item.clip });
    }
  }

  if (opts.activate) safe(function () { proc.frontmost = true; });

  return JSON.stringify({ app: owner.name, pid: owner.pid, visited: visited, truncated: truncated, elements: elements });
}
