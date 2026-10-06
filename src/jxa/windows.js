// JavaScript for Automation (JXA) — run with `osascript -l JavaScript`.
//
// Lists every app window (including minimised ones) and browser tab, or brings
// one to the front. Used by Jarvis for "switch to the budget spreadsheet".
//
// argv[0] is a JSON object:
//   { op: 'list', excludePid, tabs: true }
//     -> { windows: [{ pid, app, index, title, minimized }], tabs: [{ app, window, tab, title, url }] }
//   { op: 'raise', pid, index, title }         a window (index into the app's AXWindows,
//                                               title double-checked so we raise the right one)
//   { op: 'tab', app, window, tab }             a browser tab (1-based window and tab)

ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);

// Browsers whose tabs we can list and switch to, and what each calls a tab's title.
var BROWSERS = { Safari: 'name', 'Google Chrome': 'title', 'Brave Browser': 'title', 'Microsoft Edge': 'title', Arc: 'title' };

function safe(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function isNil(o) {
  return !o || safe(function () { return o.isNil(); }, true);
}

function getAttr(el, name) {
  var r = Ref();
  var err = $.AXUIElementCopyAttributeValue(el, $(name), r);
  if (err === -25211) throw new Error('AX error -25211: assistive access not allowed');
  return err === 0 ? $(r[0]) : null;
}

function text(o) {
  if (isNil(o) || !o.isKindOfClass($.NSString)) return '';
  return o.js;
}

function bool(o) {
  if (isNil(o) || !o.isKindOfClass($.NSNumber)) return false;
  return Boolean(o.js);
}

function list(o) {
  if (isNil(o) || !o.isKindOfClass($.NSArray)) return [];
  var out = [];
  for (var i = 0; i < o.count; i++) out.push(o.objectAtIndex(i));
  return out;
}

// Ordinary apps (the ones with a Dock icon), except us.
function apps(excludePid) {
  var running = $.NSWorkspace.sharedWorkspace.runningApplications;
  var out = [];
  for (var i = 0; i < running.count; i++) {
    var ra = running.objectAtIndex(i);
    if (ra.activationPolicy !== 0 || ra.processIdentifier === excludePid) continue;
    out.push({ ra: ra, pid: ra.processIdentifier, name: ObjC.unwrap(ra.localizedName) });
  }
  return out;
}

function appWindows(pid) {
  var el = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetMessagingTimeout(el, 0.4);
  return { el: el, windows: list(safe(function () { return getAttr(el, 'AXWindows'); }, null)) };
}

function pair(o,a,b) {if(isNil(o))return null;var m=new RegExp(a+':(-?[\\d.]+) '+b+':(-?[\\d.]+)').exec(ObjC.unwrap(o.description)||'');return m?[parseFloat(m[1]),parseFloat(m[2])]:null;}
function listAll(opts) {
  var windows = [];
  var tabs = [];
  apps(opts.excludePid || -1).forEach(function (a) {
    appWindows(a.pid).windows.forEach(function (w, index) {
      var sub = text(safe(function () { return getAttr(w, 'AXSubrole'); }, null));
      if (sub && sub !== 'AXStandardWindow' && sub !== 'AXDialog') return;
      var pos=pair(safe(function(){return getAttr(w,'AXPosition')},null),'x','y');
      var size=pair(safe(function(){return getAttr(w,'AXSize')},null),'w','h');
      windows.push({ rect:pos&&size?{x:pos[0],y:pos[1],w:size[0],h:size[1]}:null,frontmost:$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier===a.pid,dialog:sub==='AXDialog',edited:bool(safe(function(){return getAttr(w,'AXEdited')},null)),fullscreen:bool(safe(function(){return getAttr(w,'AXFullScreen')},null)),pid: a.pid, app: a.name, index: index, title: text(safe(function () { return getAttr(w, 'AXTitle'); }, null)), minimized: bool(safe(function () { return getAttr(w, 'AXMinimized'); }, null)) });
    });
    if (opts.tabs && BROWSERS[a.name]) {
      safe(function () {
        var b = Application(a.name);
        var titleKey = BROWSERS[a.name];
        var ws = b.windows();
        for (var i = 0; i < ws.length && i < 20; i++) {
          var ts = ws[i].tabs();
          for (var j = 0; j < ts.length && j < 80; j++) {
            tabs.push({ app: a.name, window: i + 1, tab: j + 1, title: safe(function () { return ts[j][titleKey](); }, ''), url: safe(function () { return ts[j].url(); }, '') });
          }
        }
      });
    }
  });
  return { windows: windows, tabs: tabs };
}

function bringAppForward(pid) {
  var ra = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!isNil(ra)) ra.activateWithOptions(2); // NSApplicationActivateIgnoringOtherApps
}

function raise(opts) {
  var aw = appWindows(opts.pid);
  var w = aw.windows[opts.index];
  // The list may have changed since we looked: find the window by its title instead.
  if (!w || (opts.title && text(safe(function () { return getAttr(w, 'AXTitle'); }, null)) !== opts.title)) {
    w = aw.windows.filter(function (x) { return text(safe(function () { return getAttr(x, 'AXTitle'); }, null)) === opts.title; })[0];
  }
  if (!w) return { ok: false, error: 'window not found' };
  $.AXUIElementSetAttributeValue(w, $('AXMinimized'), $.NSNumber.numberWithBool(false));
  $.AXUIElementPerformAction(w, $('AXRaise'));
  $.AXUIElementSetAttributeValue(w, $('AXMain'), $.NSNumber.numberWithBool(true));
  bringAppForward(opts.pid);
  return { ok: true };
}

function tab(opts) {
  if (!BROWSERS[opts.app]) return { ok: false, error: 'not a browser' };
  var b = Application(opts.app);
  var w = b.windows[opts.window - 1];
  if (opts.app === 'Safari') w.currentTab = w.tabs[opts.tab - 1];
  else w.activeTabIndex = opts.tab;
  w.index = 1;
  b.activate();
  return { ok: true };
}

function manage(opts) {
  var target=opts.window;
  var ra=$.NSRunningApplication.runningApplicationWithProcessIdentifier(target.pid);
  if(isNil(ra)||ObjC.unwrap(ra.localizedName)!==target.app)return {ok:false,error:'App no longer available'};
  var aw=appWindows(target.pid),matches=aw.windows.filter(function(w){return text(getAttr(w,'AXTitle'))===target.title});
  // Never guess among duplicate/untitled windows or a stale inventory.
  if(matches.length!==1)return {ok:false,error:'Window changed or its title is ambiguous'};
  var w=matches[0];
  if(text(getAttr(w,'AXSubrole'))==='AXDialog'||bool(getAttr(w,'AXFullScreen')))return {ok:false,error:'Dialog or fullscreen window left alone'};
  if(opts.kind==='close'){
    if(bool(getAttr(w,'AXEdited')))return {ok:false,error:'Unsaved document left open'};
    var button=getAttr(w,'AXCloseButton');if(isNil(button))return {ok:false,error:'No close control'};
    var err=$.AXUIElementPerformAction(button,$('AXPress'));if(err!==0)return {ok:false,error:'Close refused: '+err};
    delay(.3);
    var dialog=appWindows(target.pid).windows.some(function(x){return text(getAttr(x,'AXSubrole'))==='AXDialog'||list(getAttr(x,'AXSheets')).length>0});
    return {ok:true,dialog:dialog};
  }
  if(opts.rect){
    var se=Application('System Events'),proc=se.processes.whose({unixId:target.pid})[0];
    var sw=proc.windows.whose({name:target.title});if(sw.length!==1)return {ok:false,error:'Window geometry target changed'};
    sw[0].position=[opts.rect.x,opts.rect.y];sw[0].size=[opts.rect.w,opts.rect.h];
  }
  var minimized=opts.kind==='minimize'||(opts.kind==='restore'&&opts.minimized);
  var result=$.AXUIElementSetAttributeValue(w,$('AXMinimized'),$.NSNumber.numberWithBool(Boolean(minimized)));
  return result===0?{ok:true}:{ok:false,error:'Window refused minimisation: '+result};
}

function run(argv) {
  var opts = JSON.parse(argv[0] || '{}');
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ ok: false, error: 'AX error -25211: assistive access not allowed' });
  var out;
  if (opts.op === 'list') out = listAll(opts);
  else if (opts.op === 'manage') out = manage(opts);
  else if (opts.op === 'raise') out = raise(opts);
  else if (opts.op === 'tab') out = safe(function () { return tab(opts); }, { ok: false, error: 'could not switch tab' });
  else out = { ok: false, error: 'unknown op' };
  return JSON.stringify(out);
}
