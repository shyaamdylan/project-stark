// JavaScript for Automation (JXA) — run with `osascript -l JavaScript`.
//
// Window and tab control for workspace organising and app switching.
// argv[0] is a JSON options object:
//   { action: 'list', excludePid, tabs }      -> { windows: [...], tabs: [...] }
//   { action: 'apply', ops: [...] }           -> { results: [...] }  (stops at a save dialog)
//   { action: 'focus-tab', app, window, tab } -> { ok }
//
// A window is addressed by { pid, index, title }: the title is tried first
// (indexes shift as windows move), then the index.

ObjC.import('CoreGraphics');

var BROWSERS = {
  'Safari': 'safari', 'Google Chrome': 'chrome', 'Arc': 'chrome', 'Microsoft Edge': 'chrome',
  'Brave Browser': 'chrome', 'Chromium': 'chrome', 'Vivaldi': 'chrome',
};

function safe(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function attr(el, name) {
  return safe(function () { return el.attributes[name].value(); }, null);
}

// Front-to-back order of on-screen windows, as { pid, x, y, w, h }.
function zOrder(excludePid) {
  var ref = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.kCGWindowLayer !== 0 || w.kCGWindowOwnerPID === excludePid) continue;
    var b = w.kCGWindowBounds;
    if (!b || b.Width < 60 || b.Height < 60) continue;
    out.push({ pid: w.kCGWindowOwnerPID, x: b.X, y: b.Y, w: b.Width, h: b.Height });
  }
  return out;
}

function zIndexOf(z, pid, rect) {
  for (var i = 0; i < z.length; i++) {
    var o = z[i];
    if (o.pid === pid && Math.abs(o.x - rect.x) < 3 && Math.abs(o.y - rect.y) < 3 && Math.abs(o.w - rect.w) < 3) return i;
  }
  return null;
}

function listWindows(opts) {
  var se = Application('System Events');
  var procs = se.processes.whose({ backgroundOnly: false })();
  var z = zOrder(opts.excludePid || -1);
  var frontPid = z.length ? z[0].pid : null;
  var windows = [];
  var running = {};
  for (var p = 0; p < procs.length; p++) {
    var proc = procs[p];
    var pid = safe(function () { return proc.unixId(); }, null);
    var app = safe(function () { return proc.name(); }, '');
    if (!pid || pid === opts.excludePid) continue;
    running[app] = true;
    var wins = safe(function () { return proc.windows(); }, []);
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      var subrole = attr(w, 'AXSubrole');
      // Skip palettes, dialogs, popovers: only real document/app windows.
      if (subrole && subrole !== 'AXStandardWindow') continue;
      var pos = safe(function () { return w.position(); }, null);
      var size = safe(function () { return w.size(); }, null);
      if (!pos || !size || size[0] < 60 || size[1] < 60) continue;
      var rect = { x: pos[0], y: pos[1], w: size[0], h: size[1] };
      var minimized = !!attr(w, 'AXMinimized');
      var zi = minimized ? null : zIndexOf(z, pid, rect);
      windows.push({
        pid: pid,
        app: app,
        index: i,
        title: String(safe(function () { return w.name(); }, '') || ''),
        rect: rect,
        minimized: minimized,
        fullscreen: !!attr(w, 'AXFullScreen'),
        document: attr(w, 'AXDocument') || null,
        // Unsaved changes show up as a dot in the close button (AXEdited on some apps).
        edited: !!safe(function () { return w.buttons.whose({ subrole: 'AXCloseButton' })[0].attributes['AXEdited'].value(); }, false),
        sheet: safe(function () { return w.sheets().length > 0; }, false),
        z: zi,
        frontmost: pid === frontPid && zi === 0,
      });
    }
  }
  return { windows: windows, tabs: opts.tabs ? listTabs(running) : [] };
}

// Tabs of browsers that are already running (never launch one just to look).
function listTabs(running) {
  var tabs = [];
  for (var name in BROWSERS) {
    if (!running[name]) continue;
    var kind = BROWSERS[name];
    var b = safe(function () { return Application(name); }, null);
    if (!b) continue;
    var wins = safe(function () { return b.windows(); }, []);
    for (var wi = 0; wi < wins.length && wi < 20; wi++) {
      var ts = safe(function () { return wins[wi].tabs(); }, []);
      var titles = safe(function () { return kind === 'safari' ? wins[wi].tabs.name() : wins[wi].tabs.title(); }, []);
      var urls = safe(function () { return wins[wi].tabs.url(); }, []);
      for (var ti = 0; ti < ts.length && ti < 100; ti++) {
        tabs.push({ app: name, window: wi, tab: ti, title: String(titles[ti] || ''), url: String(urls[ti] || '') });
      }
    }
  }
  return tabs;
}

function findWindow(target) {
  var se = Application('System Events');
  var procs = se.processes.whose({ unixId: target.pid })();
  if (!procs.length) return null;
  var proc = procs[0];
  var wins = safe(function () { return proc.windows(); }, []);
  if (target.title) {
    for (var i = 0; i < wins.length; i++) {
      if (safe(function () { return wins[i].name(); }, '') === target.title) return { proc: proc, win: wins[i] };
    }
  }
  if (target.index != null && wins[target.index]) return { proc: proc, win: wins[target.index] };
  return null;
}

function setFrame(win, r) {
  win.position = [r.x, r.y];
  win.size = [r.w, r.h];
  // Some apps clamp the first resize against the old position; set it once more.
  win.position = [r.x, r.y];
}

function applyOp(op) {
  var found = findWindow(op.window);
  if (!found) return { ok: false, error: 'missing' };
  var win = found.win;
  if (op.kind === 'minimize') {
    win.attributes['AXMinimized'].value = true;
    return { ok: true };
  }
  if (op.kind === 'frame') {
    if (attr(win, 'AXMinimized')) win.attributes['AXMinimized'].value = false;
    setFrame(win, op.rect);
    return { ok: true };
  }
  if (op.kind === 'restore') {
    if (!op.minimized && attr(win, 'AXMinimized')) win.attributes['AXMinimized'].value = false;
    if (op.rect) setFrame(win, op.rect);
    if (op.minimized) win.attributes['AXMinimized'].value = true;
    return { ok: true };
  }
  if (op.kind === 'focus') {
    if (attr(win, 'AXMinimized')) win.attributes['AXMinimized'].value = false;
    safe(function () { win.actions['AXRaise'].perform(); });
    found.proc.frontmost = true;
    return { ok: true };
  }
  if (op.kind === 'close') {
    var btn = safe(function () { return win.buttons.whose({ subrole: 'AXCloseButton' })[0]; }, null);
    if (!btn) return { ok: false, error: 'no-close-button' };
    btn.click();
    delay(0.5);
    // Still there with a sheet attached = "Do you want to save?" Leave it for the user.
    var still = findWindow(op.window);
    if (still && safe(function () { return still.win.sheets().length > 0; }, false)) {
      found.proc.frontmost = true;
      return { ok: true, dialog: true };
    }
    return { ok: true };
  }
  return { ok: false, error: 'unknown-op' };
}

function focusTab(opts) {
  var b = Application(opts.app);
  var w = b.windows[opts.window];
  var t = w.tabs[opts.tab];
  if (BROWSERS[opts.app] === 'safari') w.currentTab = t;
  else w.activeTabIndex = opts.tab + 1;
  w.index = 1;
  b.activate();
  return { ok: true };
}

function run(argv) {
  var opts = {};
  try { opts = JSON.parse(argv[0] || '{}'); } catch (e) {}
  if (opts.action === 'list') return JSON.stringify(listWindows(opts));
  if (opts.action === 'focus-tab') return JSON.stringify(focusTab(opts));
  if (opts.action === 'apply') {
    var results = [];
    var ops = opts.ops || [];
    for (var i = 0; i < ops.length; i++) {
      var r;
      try { r = applyOp(ops[i]); } catch (e) { r = { ok: false, error: String(e) }; }
      results.push(r);
      if (r.dialog) break;
    }
    return JSON.stringify({ results: results });
  }
  return JSON.stringify({ error: 'unknown-action' });
}
