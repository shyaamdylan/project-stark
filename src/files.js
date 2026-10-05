// Finding and opening files for Jarvis ("Jarvis, open the Q3 report").
//
// Search uses Spotlight (mdfind), limited to your home folder and the
// Applications folders. Opening goes through Electron's shell.openPath, which
// hands the file to its default app, exactly like double-clicking it in Finder.
//
// Safety: nothing that runs code is opened. Scripts, installers and command
// files are refused, and apps are only launched from the Applications folders,
// never from Downloads or elsewhere. Hidden folders and ~/Library are skipped.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize } = require('./matcher');

// Opening any of these runs code.
const BLOCKED_EXT = new Set([
  'command', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'tool', 'terminal', 'scpt', 'scptd', 'applescript',
  'workflow', 'action', 'pkg', 'mpkg', 'jar', 'py', 'rb', 'pl', 'php', 'js', 'mjs', 'cjs', 'exe', 'msi',
  'bat', 'cmd', 'com', 'vbs', 'ps1', 'dylib', 'kext', 'plugin', 'prefpane', 'saver', 'mobileconfig',
  'webloc', 'inetloc', 'fileloc', 'url', 'scr', 'osax', 'service', 'qlgenerator', 'xpc',
]);

// Apps may only be launched from here.
function appRoots(home = os.homedir()) {
  return ['/Applications', '/System/Applications', path.join(home, 'Applications')];
}

const within = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

// Is it OK to open this path? Returns { ok: true } or { ok: false, why }.
// `info` is { isDirectory, isFile, mode } (from fs.statSync), passed in so it can be tested.
function openVerdict(realPath, info, home = os.homedir()) {
  const p = realPath;
  const roots = [home, ...appRoots(home)];
  if (!roots.some((r) => within(p, r))) return { ok: false, why: 'outside' };
  const rel = within(p, home) ? path.relative(home, p) : '';
  if (rel && (rel.split(path.sep).some((part) => part.startsWith('.')) || within(p, path.join(home, 'Library')))) return { ok: false, why: 'hidden' };
  const ext = path.extname(p).slice(1).toLowerCase();
  if (ext === 'app') {
    return appRoots(home).some((r) => within(p, r)) ? { ok: true, kind: 'app' } : { ok: false, why: 'app-outside-applications' };
  }
  if (BLOCKED_EXT.has(ext)) return { ok: false, why: 'runs-code' };
  if (info && info.isDirectory) return { ok: true, kind: 'folder' };
  // A plain file marked executable, with no document extension, is a program.
  if (info && info.isFile && !ext && info.mode & 0o111) return { ok: false, why: 'runs-code' };
  return { ok: true, kind: 'file' };
}

// File types people say out loud, so "the budget spreadsheet" looks for a spreadsheet.
const TYPE_WORDS = {
  pdf: ['pdf'], doc: ['doc', 'docx', 'pages'], document: ['doc', 'docx', 'pages', 'pdf', 'txt', 'rtf', 'md'],
  word: ['doc', 'docx'], spreadsheet: ['xls', 'xlsx', 'numbers', 'csv'], excel: ['xls', 'xlsx'], sheet: ['xls', 'xlsx', 'numbers', 'csv'],
  csv: ['csv'], presentation: ['key', 'ppt', 'pptx'], slides: ['key', 'ppt', 'pptx'], deck: ['key', 'ppt', 'pptx'],
  keynote: ['key'], powerpoint: ['ppt', 'pptx'], image: ['png', 'jpg', 'jpeg', 'heic', 'gif'], photo: ['png', 'jpg', 'jpeg', 'heic'],
  picture: ['png', 'jpg', 'jpeg', 'heic'], screenshot: ['png', 'jpg'], video: ['mov', 'mp4', 'm4v'], movie: ['mov', 'mp4', 'm4v'],
  text: ['txt', 'md', 'rtf'], app: ['app'], application: ['app'], folder: [''],
};
const FILLER = new Set(['the', 'my', 'a', 'an', 'that', 'this', 'file', 'files', 'called', 'named', 'please', 'for', 'me', 'up', 'latest', 'last', 'recent', 'new', 'newest']);

// "the q3 budget spreadsheet" -> { words: ['q3', 'budget'], exts: ['xls', 'xlsx', 'numbers', 'csv'] }
function parseQuery(text) {
  const raw = String(text || '').toLowerCase().replace(/[.!?]+$/, '');
  // "report.pdf" keeps its extension as a filter.
  const dotted = /\.([a-z0-9]{2,5})$/.exec(raw.trim());
  let exts = dotted ? [dotted[1]] : null;
  const words = raw.replace(/\.[a-z0-9]{2,5}$/, '').replace(/["*\\]/g, ' ').split(/[^a-z0-9'&_-]+/).filter(Boolean);
  const keep = [];
  for (const w of words) {
    if (TYPE_WORDS[w] && !exts) exts = TYPE_WORDS[w];
    else if (!FILLER.has(w) && !TYPE_WORDS[w]) keep.push(w);
  }
  return { words: keep, exts };
}

function mdfind(root, query) {
  return new Promise((resolve) => {
    execFile('/usr/bin/mdfind', ['-onlyin', root, query], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : stdout.split('\n').filter(Boolean));
    });
  });
}

// How well a path's name matches the words (higher is better).
function score(file, words) {
  const base = normalize(path.basename(file).replace(/\.[^.]+$/, ''));
  const want = normalize(words.join(' '));
  if (base === want) return 1;
  if (base.startsWith(want)) return 0.9;
  if (base.includes(want)) return 0.8;
  return 0.6 + 0.1 * (want.length / Math.max(want.length, base.length));
}

// Up to `limit` candidates, best first: { path, name, kind }.
async function findFiles(text, { limit = 5, home = os.homedir() } = {}) {
  const { words, exts } = parseQuery(text);
  if (!words.length) return [];
  // Every word must be in the name; quotes and wildcards were stripped in parseQuery.
  const query = words.map((w) => `kMDItemDisplayName == "*${w}*"cd`).join(' && ');
  const roots = [home, ...appRoots(home).filter((r) => fs.existsSync(r) && !within(r, home))];
  const found = [...new Set((await Promise.all(roots.map((r) => mdfind(r, query)))).flat())];
  const results = [];
  for (const p of found) {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (exts && !exts.includes(ext)) continue;
    // Skip files inside app bundles and packages.
    if (/\.(app|bundle|framework|photoslibrary|pages|numbers|key)\//i.test(p)) continue;
    let real;
    let st;
    try {
      real = fs.realpathSync(p);
      st = fs.statSync(real);
    } catch {
      continue;
    }
    const verdict = openVerdict(real, { isDirectory: st.isDirectory(), isFile: st.isFile(), mode: st.mode }, home);
    if (!verdict.ok && verdict.why === 'hidden') continue;
    results.push({ path: real, name: path.basename(real), kind: verdict.kind || 'file', blocked: verdict.ok ? null : verdict.why, score: score(real, words), mtime: st.mtimeMs });
  }
  results.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return results.slice(0, limit);
}

module.exports = { findFiles, openVerdict, parseQuery, score, BLOCKED_EXT };
