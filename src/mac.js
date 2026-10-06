// macOS side of the workspace + launcher features: windows/tabs (via JXA),
// installed apps, project folders, Spotlight file search, and opening things.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hostOf } = require('./launcher');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'jxa', 'windows.js'), 'utf8');

function run(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(String(stderr || err.message)), { stderr: String(stderr || '') }));
      resolve(stdout);
    });
  });
}

async function jxa(opts, timeoutMs = 15000) {
  const out = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, JSON.stringify(opts)], timeoutMs);
  return JSON.parse(out.trim());
}

async function listWindows({ tabs = false } = {}) {
  const res = await jxa({ action: 'list', excludePid: process.pid, tabs });
  return { windows: res.windows || [], tabs: (res.tabs || []).map((t) => ({ ...t, host: hostOf(t.url) })) };
}

// Applies one organiser op; resolves {dialog:true} if a save dialog appeared.
async function changeWindow(op) {
  const res = await jxa({ action: 'apply', ops: [{ kind: op.kind, window: op.window, rect: op.rect, minimized: op.minimized }] });
  const r = (res.results || [])[0] || {};
  if (!r.ok) throw new Error(r.error || 'failed');
  return r;
}

const focusWindow = (w) => changeWindow({ kind: 'focus', window: w });
const focusTab = (t) => jxa({ action: 'focus-tab', app: t.app, window: t.window, tab: t.tab });

// ---------- apps ----------

const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications')];
let appCache = null;

function listApps() {
  if (appCache && Date.now() - appCache.at < 5 * 60e3) return appCache.apps;
  const apps = [];
  for (const dir of APP_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.app')) apps.push({ type: 'app', name: n.slice(0, -4), path: path.join(dir, n) });
  }
  appCache = { at: Date.now(), apps };
  return apps;
}

// ---------- projects ----------

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml',
  'build.gradle', 'Package.swift', 'requirements.txt', 'composer.json', 'Makefile'];
const DEFAULT_PROJECT_DIRS = ['Developer', 'Projects', 'projects', 'Code', 'code', 'src', 'dev', 'repos', 'GitHub',
  'Documents/GitHub', 'Documents/Projects', 'Documents/Code', 'Desktop'];
let projectCache = null;

function listProjects(extraDirs = []) {
  if (projectCache && Date.now() - projectCache.at < 5 * 60e3) return projectCache.projects;
  const home = os.homedir();
  const roots = [...extraDirs, ...DEFAULT_PROJECT_DIRS.map((d) => path.join(home, d))];
  const out = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (seen.has(full)) continue;
      if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(full, m)))) {
        seen.add(full);
        out.push({ type: 'project', name: e.name, path: full });
      } else if (depth < 1) {
        visit(full, depth + 1); // one level of grouping, e.g. ~/Projects/work/<repo>
      }
    }
  };
  for (const r of roots) visit(r, 0);
  projectCache = { at: Date.now(), projects: out };
  return out;
}

// ---------- files (Spotlight) ----------

async function searchFiles(query, { limit = 40 } = {}) {
  const terms = String(query).split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
  if (!terms.length) return [];
  const esc = (t) => t.replace(/["\\*]/g, '');
  const expr = terms.map((t) => `kMDItemFSName == "*${esc(t)}*"cd`).join(' && ');
  let out = '';
  try {
    out = await run('/usr/bin/mdfind', ['-onlyin', os.homedir(), expr], 6000);
  } catch {
    return [];
  }
  const skip = /\/(Library|node_modules|\.Trash|\.git|\.cache|Caches)\//;
  const results = [];
  for (const p of out.split('\n')) {
    if (!p || skip.test(p) || /\.app(\/|$)/.test(p)) continue;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    results.push({ type: st.isDirectory() ? 'folder' : 'file', name: path.basename(p), path: p, usedAt: st.atimeMs || st.mtimeMs });
    if (results.length >= limit) break;
  }
  return results;
}

// ---------- opening ----------

const EDITORS = ['Cursor', 'Visual Studio Code', 'Zed', 'Sublime Text', 'Nova', 'Xcode'];

function editorFor(preferred) {
  const apps = listApps();
  for (const name of [preferred, ...EDITORS].filter(Boolean)) {
    if (apps.some((a) => a.name.toLowerCase() === name.toLowerCase())) return name;
  }
  return null;
}

async function openApp(app) {
  await run('/usr/bin/open', ['-a', app.path || app.name]);
}

async function openProject(project, preferredEditor) {
  const editor = editorFor(preferredEditor);
  await run('/usr/bin/open', editor ? ['-a', editor, project.path] : [project.path]);
  return editor;
}

module.exports = { listWindows, changeWindow, focusWindow, focusTab, listApps, listProjects, searchFiles, openApp, openProject, editorFor };
