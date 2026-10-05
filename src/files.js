// Finding and opening files for Jarvis ("Jarvis, open the Q3 report").
//
// Search uses Spotlight (mdfind), limited to your home folder and the
// Applications folders. Opening goes through Electron's shell.openPath, which
// hands the file to its default app, exactly like double-clicking it in Finder.
//
// Safety: nothing that runs code is opened. Scripts, installers and command
// files are refused, and apps are only launched from the Applications folders,
// never from Downloads or elsewhere. Hidden folders and ~/Library are skipped.

const { spawn } = require('child_process');
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
  pdf: ['pdf'], pdfs: ['pdf'], doc: ['doc', 'docx', 'pages'], docs: ['doc', 'docx', 'pages'], document: ['doc', 'docx', 'pages', 'pdf', 'txt', 'rtf', 'md'],
  word: ['doc', 'docx'], spreadsheet: ['xls', 'xlsx', 'numbers', 'csv'], excel: ['xls', 'xlsx'], sheet: ['xls', 'xlsx', 'numbers', 'csv'],
  csv: ['csv'], presentation: ['key', 'ppt', 'pptx'], slides: ['key', 'ppt', 'pptx'], deck: ['key', 'ppt', 'pptx'],
  keynote: ['key'], powerpoint: ['ppt', 'pptx'], image: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp'], photo: ['png', 'jpg', 'jpeg', 'heic'],
  picture: ['png', 'jpg', 'jpeg', 'heic'], pic: ['png', 'jpg', 'jpeg', 'heic'], video: ['mov', 'mp4', 'm4v'], movie: ['mov', 'mp4', 'm4v'],
  recording: ['mov', 'mp4', 'm4a'], audio: ['mp3', 'm4a', 'wav'], song: ['mp3', 'm4a'], text: ['txt', 'md', 'rtf'], note: ['txt', 'md', 'rtf'],
  zip: ['zip'], app: ['app'], application: ['app'], folder: [''],
};
// Folders people name: "on my desktop", "in downloads", "the file I downloaded".
const FOLDERS = { desktop: 'Desktop', documents: 'Documents', docs_folder: 'Documents', downloads: 'Downloads', pictures: 'Pictures', photos: 'Pictures', movies: 'Movies', music: 'Music', home: '', icloud: 'Library/Mobile Documents/com~apple~CloudDocs' };
const DAYS = { today: 1, yesterday: 2, 'this week': 7, 'last week': 14, 'this month': 31, 'last month': 62, recently: 14, recent: 14 };
const FILLER = new Set(['the', 'my', 'a', 'an', 'that', 'this', 'file', 'files', 'called', 'named', 'please', 'for', 'me', 'up', 'i', 'it', 'one', 'of', 'with', 'from', 'was', 'were', 'had', 'have', 'which', 'where', 'just', 'some', 'saved', 'made', 'created', 'edited', 'worked', 'on', 'in', 'to', 'at', 'is', 'are', 'about', 'any', 'all', 'our', 'your', 'can', 'you', 'find', 'open', 'show', 'get', 'new', 'version']);
const NEWEST = /\b(latest|newest|most recent|last|recent)\b/;

// "the pdf I downloaded yesterday in Preview" ->
// { words: [], exts: ['pdf'], folder: 'Downloads', sinceDays: 2, newest: false, withApp: 'Preview', folderOnly: false }
function parseQuery(text) {
  let raw = String(text || '').toLowerCase().replace(/[.!?]+$/, '').trim();
  // "... in Preview" / "with Numbers": a named app to open it with (checked later).
  let withApp = null;
  const w = / (?:in|with|using) ([a-z][a-z0-9 ]{1,24}?)(?: app)?$/.exec(raw);
  if (w && !FOLDERS[w[1].replace(/ folder$/, '').replace(/^my /, '')] && !TYPE_WORDS[w[1]]) {
    withApp = w[1].replace(/\b\w/g, (c) => c.toUpperCase());
    raw = raw.slice(0, w.index);
  }
  let folder = null;
  const f = /\b(?:in|on|from) (?:my |the )?(desktop|documents|downloads|pictures|photos|movies|music|icloud(?: drive)?)(?: folder)?\b/.exec(raw);
  if (f) {
    folder = FOLDERS[f[1].split(' ')[0]];
    raw = raw.replace(f[0], ' ');
  }
  if (/\bdownloaded\b/.test(raw) && folder == null) folder = 'Downloads';
  let sinceDays = null;
  for (const [k, d] of Object.entries(DAYS)) {
    if (new RegExp(`\\b${k}\\b`).test(raw)) {
      sinceDays = d;
      raw = raw.replace(new RegExp(`\\b${k}\\b`), ' ');
      break;
    }
  }
  const newest = NEWEST.test(raw);
  raw = raw.replace(new RegExp(NEWEST.source, 'g'), ' ').replace(/\bdownloaded\b/, ' ');
  // "report.pdf" / "the README.md for PianoScribe" keeps its extension as a filter.
  const dotted = /\b[a-z0-9_-]+\.([a-z0-9]{1,5})\b/.exec(raw);
  let exts = dotted ? [dotted[1]] : null;
  if (dotted) raw = raw.replace(`.${dotted[1]}`, ' ');
  const words = raw.replace(/\band open it\b|\band show (?:it|me)\b/g, ' ').replace(/["*\\]/g, ' ').split(/[^a-z0-9'&_-]+/).filter(Boolean);
  // "open my downloads (folder)": the folder itself.
  const named = words.filter((x) => !FILLER.has(x) && x !== 'folder');
  if (folder == null && named.length === 1 && FOLDERS[named[0]] !== undefined && named[0] !== 'home') {
    return { words: [], exts: null, folder: FOLDERS[named[0]], sinceDays: null, newest: false, withApp, folderOnly: true };
  }
  const keep = [];
  for (const word of words) {
    if (TYPE_WORDS[word] && !exts) exts = TYPE_WORDS[word];
    else if (!FILLER.has(word) && !TYPE_WORDS[word]) keep.push(word.replace(/'s$/, ''));
  }
  return { words: keep, exts, folder, sinceDays, newest, withApp, folderOnly: false };
}

// Spotlight, stopped after `limit` results so broad searches stay quick.
function mdfind(args, limit = 400, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn('/usr/bin/mdfind', args);
    } catch {
      return resolve([]);
    }
    const out = [];
    let buf = '';
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0 && out.length < limit) {
        out.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (out.length >= limit) p.kill();
    });
    p.on('error', () => resolve([]));
    p.on('close', () => {
      clearTimeout(t);
      if (buf && out.length < limit) out.push(buf);
      resolve(out.filter(Boolean));
    });
  });
}

const esc = (w) => w.replace(/["*\\]/g, '');

// Spotlight query for names containing every word, optionally changed or used recently.
function nameQuery(words, sinceDays) {
  const parts = words.map((w) => `kMDItemDisplayName == "*${esc(w)}*"cd`);
  if (sinceDays) parts.push(`(kMDItemFSContentChangeDate >= $time.today(-${sinceDays}) || kMDItemLastUsedDate >= $time.today(-${sinceDays}) || kMDItemDateAdded >= $time.today(-${sinceDays}))`);
  return parts.join(' && ');
}

// Any file of these types, for "the pdf I downloaded yesterday" (no name words).
function typeQuery(exts, sinceDays) {
  const types = exts.filter(Boolean).map((e) => `kMDItemFSName == "*.${esc(e)}"c`);
  const parts = [types.length ? `(${types.join(' || ')})` : 'kMDItemFSName == "*"'];
  parts.push(`(kMDItemFSContentChangeDate >= $time.today(-${sinceDays || 30}) || kMDItemLastUsedDate >= $time.today(-${sinceDays || 30}) || kMDItemDateAdded >= $time.today(-${sinceDays || 30}))`);
  return parts.join(' && ');
}

const SKIP_PATH = /\/(node_modules|\.git|Caches|DerivedData|\.Trash)\/|\.(app|bundle|framework|photoslibrary|pages|numbers|key|xcodeproj|lproj)\//i;
const NICE_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents/com~apple~CloudDocs'];

// How good a candidate is: how much of its name matches, then how recently it
// was touched and whether it's somewhere people keep their things.
function score(file, words, { mtime = 0, home = os.homedir(), now = Date.now() } = {}) {
  const base = normalize(path.basename(file).replace(/\.[^.]+$/, ''));
  const want = normalize(words.join(' '));
  let s;
  if (!want) s = 0.7;
  else if (base === want) s = 1;
  else if (base.startsWith(want)) s = 0.92;
  else if (base.includes(want)) s = 0.85;
  else {
    const ws = want.split(' ');
    const hit = ws.filter((w) => base.includes(w)).length / ws.length;
    s = 0.45 + 0.35 * hit;
  }
  const days = Math.max(0, (now - mtime) / 86400000);
  s += 0.08 * Math.exp(-days / 30);
  if (NICE_FOLDERS.some((f) => within(file, path.join(home, f)))) s += 0.03;
  // Deep inside a project (logs, build output) is less likely what was meant
  // than the project folder or its top-level files.
  if (within(file, home)) s -= 0.04 * Math.max(0, path.relative(home, path.dirname(file)).split(path.sep).length - 2);
  return s;
}

// Choices the user made before ("the second one"), so the same request goes straight there.
let picksFile = null;
let picks = null;
function setPicksFile(file) {
  picksFile = file;
  picks = null;
}
const pickKey = (text) => normalize(parseQuery(text).words.join(' ') + ' ' + (parseQuery(text).exts || []).join(' ')).trim();
function loadPicks() {
  if (picks) return picks;
  try {
    picks = JSON.parse(fs.readFileSync(picksFile, 'utf8'));
  } catch {
    picks = {};
  }
  return picks;
}
function rememberPick(text, file) {
  if (!picksFile) return;
  const key = pickKey(text);
  if (!key) return;
  const all = loadPicks();
  all[key] = file;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
  try {
    fs.writeFileSync(picksFile, JSON.stringify(all, null, 2));
  } catch {}
}

function candidate(p, words, home) {
  if (SKIP_PATH.test(p)) return null;
  let real;
  let st;
  try {
    real = fs.realpathSync(p);
    st = fs.statSync(real);
  } catch {
    return null;
  }
  const verdict = openVerdict(real, { isDirectory: st.isDirectory(), isFile: st.isFile(), mode: st.mode }, home);
  if (!verdict.ok && (verdict.why === 'hidden' || verdict.why === 'outside')) return null;
  const mtime = Math.max(st.mtimeMs, st.birthtimeMs || 0);
  return { path: real, name: path.basename(real), kind: verdict.kind || 'file', blocked: verdict.ok ? null : verdict.why, score: score(real, words, { mtime, home }), mtime };
}

// Squashed for comparing names and folders: "Piano Scribe" matches "PianoScribe".
const squash = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');

// Try each way of splitting the words into the file's name and the folders
// around it ("readme" + "pianoscribe", or "piano scribe"), keeping files whose
// folders contain the rest. Searches for the same name words run once.
async function searchInFolders(words, search, home) {
  const byName = new Map();
  const out = [];
  for (let i = 1; i < words.length; i++) {
    for (const [name, context] of [[words.slice(0, i), words.slice(i)], [words.slice(i), words.slice(0, i)]]) {
      const key = name.join(' ');
      if (!byName.has(key)) byName.set(key, await search(nameQuery(name), name));
      const want = squash(context.join(''));
      for (const c of byName.get(key)) {
        const dirs = squash(path.relative(home, path.dirname(c.path)));
        if (want && dirs.includes(want)) out.push({ ...c, score: c.score - 0.03 });
      }
    }
  }
  return out;
}

// Spotlight can be switched off or still indexing (it returns nothing for the
// whole home folder then), so the same name queries can also be answered by
// walking the usual folders directly. Only `kMDItemDisplayName == "*word*"cd`
// clauses are understood: every word must be in the name. Hidden folders,
// ~/Library and build folders are skipped, and the walk is bounded.
const WALK_SKIP = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'venv', '__pycache__', 'dist', 'build', 'target', 'site-packages']);
function walkFind(args, limit = 400, { maxDepth = 5, maxEntries = 60000 } = {}) {
  const at = args.indexOf('-onlyin');
  const root = at >= 0 ? args[at + 1] : os.homedir();
  const query = args[args.length - 1];
  const words = [...String(query).matchAll(/kMDItemDisplayName == "\*([^"*]*)\*"cd/g)].map((m) => squash(m[1])).filter(Boolean);
  if (!words.length || /kMDItem(?!DisplayName)/.test(query)) return Promise.resolve([]);
  const out = [];
  let seen = 0;
  const queue = [[root, 0]];
  while (queue.length && out.length < limit && seen < maxEntries) {
    const [dir, depth] = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      seen++;
      if (d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      const name = squash(d.name);
      if (words.every((w) => name.includes(w))) out.push(p);
      if (d.isDirectory() && depth < maxDepth && !WALK_SKIP.has(d.name) && !/\.(app|bundle|framework|photoslibrary)$/i.test(d.name)) queue.push([p, depth + 1]);
    }
  }
  return Promise.resolve(out);
}

// Spotlight first; if it knows nothing at all under that folder, walk it.
async function mdfindOrWalk(args, limit) {
  const found = await mdfind(args, limit);
  if (found.length) return found;
  return walkFind(args, limit);
}

// Up to `limit` candidates, best first: { path, name, kind, blocked, score }.
// Tries, fastest first: a file you picked for this before, names containing
// every word, then names or contents matching (Spotlight's own search), then
// alternative names from `rephrase` (Claude) if given.
async function findFiles(text, { limit = 5, home = os.homedir(), rephrase = null, run = mdfindOrWalk } = {}) {
  const q = parseQuery(text);
  const roots = q.folder != null ? [path.join(home, q.folder)] : [home, ...appRoots(home).filter((r) => fs.existsSync(r) && !within(r, home))];

  if (q.folderOnly && q.folder != null) {
    const dir = path.join(home, q.folder);
    return fs.existsSync(dir) ? [{ path: dir, name: path.basename(dir) || 'Home', kind: 'folder', blocked: null, score: 1, mtime: 0 }] : [];
  }

  const remembered = loadPicks()[pickKey(text)];
  if (remembered && fs.existsSync(remembered)) {
    const c = candidate(remembered, q.words, home);
    if (c && !c.blocked) return [{ ...c, score: 2, remembered: true }];
  }

  const keepType = (c) => !q.exts || q.exts.includes(path.extname(c.path).slice(1).toLowerCase()) || (q.exts.includes('') && c.kind === 'folder');
  const collect = (paths, words) => {
    const out = [];
    for (const p of new Set(paths)) {
      const c = candidate(p, words, home);
      if (c && keepType(c)) out.push(c);
    }
    return out;
  };
  const search = async (query, words) => collect((await Promise.all(roots.map((r) => run(['-onlyin', r, query])))).flat(), words);

  let results = [];
  if (q.words.length) {
    results = await search(nameQuery(q.words, q.sinceDays), q.words);
    // "The README for PianoScribe": some words name the folder it's in, not the file.
    if (!results.length && q.words.length >= 2) results = await searchInFolders(q.words, search, home);
    // Nothing by name: let Spotlight match names and contents its own way.
    if (!results.length) {
      const plain = (await Promise.all(roots.map((r) => run(['-onlyin', r, q.words.join(' ')], 200)))).flat();
      results = collect(plain, q.words).filter((c) => !q.sinceDays || c.mtime >= Date.now() - q.sinceDays * 86400000);
      results.forEach((c) => (c.score -= 0.1)); // a contents match is a weaker sign than the name
    }
    // Still nothing: try what else it might be called ("tax return" -> "1040").
    if (!results.length && rephrase) {
      let alts = [];
      try {
        alts = await rephrase(text);
      } catch {}
      for (const alt of alts.slice(0, 4)) {
        const words = parseQuery(alt).words;
        if (words.length) results.push(...(await search(nameQuery(words, q.sinceDays), words)).map((c) => ({ ...c, score: c.score - 0.05 })));
      }
    }
  } else if (q.exts || q.sinceDays || q.newest) {
    results = await search(typeQuery(q.exts || [], q.sinceDays), []);
  }

  // "The latest…" means newest first; otherwise best match first, newest breaking ties.
  if (q.newest || (!q.words.length && (q.exts || q.sinceDays))) results.sort((a, b) => b.mtime - a.mtime);
  else results.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const seen = new Set();
  return results.filter((c) => !seen.has(c.path) && seen.add(c.path)).slice(0, limit);
}

// Is the top result clearly the one? Otherwise the user should pick.
function isClear(results, text) {
  if (results.length <= 1 || results[0].remembered) return true;
  const q = parseQuery(text);
  if (q.newest || (!q.words.length && (q.exts || q.sinceDays))) return true;
  return results[0].score - results[1].score >= 0.05;
}

// Claude's guesses at what a file might be called, for when nothing matches.
const REPHRASE_SCHEMA = { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'], additionalProperties: false };
function makeRephrase(apiKey, client = null) {
  const { Anthropic } = require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ apiKey });
  return async (text) => {
    const response = await c.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 600,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: REPHRASE_SCHEMA } },
      system: 'Someone asked their Mac assistant to find a file, and no file name matched their words. Suggest up to 4 short alternative searches made of words likely to be in the file\'s name: synonyms, abbreviations, official form names, common naming ("tax return" -> "1040", "resume" -> "CV", "passport scan" -> "passport"). Each 1 to 3 words. No file extensions.',
      messages: [{ role: 'user', content: text }],
    });
    if (response.stop_reason !== 'end_turn') return [];
    const out = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    return (out.queries || []).filter((x) => typeof x === 'string');
  };
}

// Reading a file's text for Jarvis (a README to follow, notes to use), or
// listing a folder. Same limits as opening: home folder only, nothing hidden
// or in ~/Library, and nothing that looks like secrets.
const SECRET_NAME = /(^|[._-])(env|secrets?|credentials?|passwords?|tokens?|keychain|id_rsa|id_ed25519|id_ecdsa)([._-]|$)|\.(pem|key|p12|pfx|keychain-db|kdbx)$/i;
const MAX_READ = 200 * 1024;

function readTextFile(file, { home = os.homedir(), maxChars = 8000 } = {}) {
  let real;
  let st;
  try {
    real = fs.realpathSync(file);
    st = fs.statSync(real);
  } catch {
    return { ok: false, why: 'missing' };
  }
  const verdict = openVerdict(real, { isDirectory: st.isDirectory(), isFile: st.isFile(), mode: st.mode }, home);
  if (!verdict.ok && verdict.why !== 'runs-code') return { ok: false, why: verdict.why };
  if (SECRET_NAME.test(path.basename(real))) return { ok: false, why: 'secret' };
  if (st.isDirectory()) {
    const entries = fs.readdirSync(real, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).slice(0, 150);
    return { ok: true, path: real, folder: true, text: entries.map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`).join('\n') };
  }
  if (st.size > MAX_READ) return { ok: false, why: 'too-big' };
  const buf = fs.readFileSync(real);
  if (buf.includes(0)) return { ok: false, why: 'not-text' };
  const text = buf.toString('utf8');
  return { ok: true, path: real, folder: false, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cut short)` : text };
}

// "~/Documents/PianoScribe/README.md", "Documents/PianoScribe" or a
// description ("the PianoScribe readme") -> a path in the home folder, or null.
async function resolveFile(query, { home = os.homedir(), run } = {}) {
  const q = String(query || '').trim();
  if (/^(~|\/|[\w .-]+\/)/.test(q)) {
    const p = q.startsWith('~') ? path.join(home, q.slice(1)) : q.startsWith('/') ? q : path.join(home, q);
    if (fs.existsSync(p)) return p;
  }
  const [best] = await findFiles(q, { home, limit: 1, ...(run ? { run } : {}) });
  return best && !best.blocked ? best.path : null;
}

module.exports = { readTextFile, resolveFile, findFiles, isClear, openVerdict, parseQuery, score, nameQuery, typeQuery, BLOCKED_EXT, appRoots, walkFind, setPicksFile, rememberPick, makeRephrase };
