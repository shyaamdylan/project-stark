// Picks the best thing to switch to / open / reveal for a request from
// src/intent.js. Candidates come from several sources (open windows, browser
// tabs, installed apps, project folders, files, well-known websites) and are
// ranked together, so "open slack" switches to the open Slack window, "open the
// budget spreadsheet" opens the file, and "go to gmail" reuses an open tab.
// Pure functions — see test/launcher.test.js.

const { normalize, textScore } = require('./matcher');

// Well-known sites by spoken name. Anything with a dot in it is opened directly.
const SITES = [
  ['gmail', 'https://mail.google.com', ['email', 'mail', 'inbox', 'google mail']],
  ['google calendar', 'https://calendar.google.com', ['calendar', 'gcal']],
  ['google drive', 'https://drive.google.com', ['drive']],
  ['google docs', 'https://docs.google.com', []],
  ['google sheets', 'https://sheets.google.com', []],
  ['google', 'https://www.google.com', []],
  ['youtube', 'https://www.youtube.com', ['yt']],
  ['github', 'https://github.com', []],
  ['claude', 'https://claude.ai', ['claude ai']],
  ['chatgpt', 'https://chatgpt.com', ['chat gpt', 'openai']],
  ['notion', 'https://www.notion.so', []],
  ['figma', 'https://www.figma.com', []],
  ['linkedin', 'https://www.linkedin.com', []],
  ['twitter', 'https://x.com', ['x']],
  ['reddit', 'https://www.reddit.com', []],
  ['netflix', 'https://www.netflix.com', []],
  ['amazon', 'https://www.amazon.com', []],
  ['google maps', 'https://maps.google.com', ['maps']],
  ['whatsapp', 'https://web.whatsapp.com', ['whatsapp web']],
  ['spotify', 'https://open.spotify.com', []],
  ['outlook', 'https://outlook.office.com', ['hotmail']],
  ['vercel', 'https://vercel.com', []],
  ['stack overflow', 'https://stackoverflow.com', ['stackoverflow']],
];

function siteCandidates() {
  return SITES.map(([name, url, aliases]) => ({ type: 'site', name, aliases, url, host: hostOf(url) }));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// How much each kind of candidate is preferred, per mode. Things already open
// win ties: switching to them is cheaper than opening a second copy.
const PRIOR = {
  switch: { window: 0.12, tab: 0.12, app: 0.06, project: -0.1, site: -0.05, file: -0.2, folder: -0.2 },
  open: { window: 0.06, tab: 0.06, app: 0.04, project: 0.02, site: 0.01, file: 0, folder: 0 },
  find: { window: -0.25, tab: -0.25, app: -0.15, project: 0.04, site: -0.3, file: 0.08, folder: 0.08 },
};

// Which hinted types each candidate type satisfies.
const SATISFIES = {
  window: ['window', 'app'], tab: ['window', 'site'], app: ['app'], project: ['project', 'folder'],
  site: ['site'], file: ['file'], folder: ['folder'],
};

// AXDocument is a file:// URL.
function docPath(doc) {
  try {
    return doc.startsWith('file://') ? decodeURIComponent(new URL(doc).pathname) : doc;
  } catch {
    return doc;
  }
}

function stripExt(name) {
  return String(name || '').replace(/\.[a-z0-9]{1,6}$/i, '');
}

function nameScore(query, label) {
  const phrase = normalize(query);
  if (!phrase || !label) return 0;
  return textScore({ phrase, terms: phrase.split(' ') }, label);
}

function scoreCandidate(req, c, now = Date.now()) {
  const q = req.query;
  let s = 0;
  switch (c.type) {
    case 'window':
      // "slack" matches the app; "budget" may match the document in the title.
      s = Math.max(nameScore(q, c.app), nameScore(q, stripExt(c.title)) * 0.95, nameScore(q, `${c.app} ${c.title}`) * 0.9);
      break;
    case 'tab':
      s = Math.max(nameScore(q, c.title) * 0.95, nameScore(q, c.host) * 0.98, nameScore(q, c.host.split('.')[0]));
      // A tab that is on the site the user named ("go to gmail") is the best answer.
      if (req.siteHost && c.host && (c.host === req.siteHost || c.host.endsWith(`.${req.siteHost}`))) s = Math.max(s, 1);
      break;
    case 'site':
      s = Math.max(nameScore(q, c.name), ...c.aliases.map((a) => nameScore(q, a) * 0.97));
      break;
    case 'file':
    case 'folder':
      s = nameScore(q, stripExt(c.name));
      if (req.extensions && req.extensions.size) {
        const ext = (c.name.match(/\.([a-z0-9]+)$/i) || [])[1];
        s += ext && req.extensions.has(ext.toLowerCase()) ? 0.06 : -0.05;
      }
      // Something touched this week is far more likely than an old namesake.
      if (c.usedAt && now - c.usedAt < 7 * 864e5) s += 0.04;
      break;
    default:
      s = nameScore(q, c.name);
  }
  if (s <= 0) return 0;
  s += (PRIOR[req.mode] || PRIOR.open)[c.type] || 0;
  if (req.types && req.types.size) {
    const ok = (SATISFIES[c.type] || []).some((t) => req.types.has(t));
    // An open window showing the requested document counts as that file.
    const openDoc = c.type === 'window' && c.document && req.types.has('file');
    s += ok || openDoc ? 0.2 : -0.35;
  }
  return s;
}

const THRESHOLD = 0.55;

// Returns { best, ranked, close } where `close` is a runner-up of a different
// kind that scored nearly as well (so the reply can mention it).
function rank(req, candidates, now = Date.now()) {
  const r = { ...req };
  if (req.url) r.siteHost = hostOf(req.url);
  else {
    const site = SITES.find(([name, , aliases]) => normalize(req.query) === name || aliases.includes(normalize(req.query)));
    if (site) r.siteHost = hostOf(site[1]);
  }
  let ranked = candidates
    .map((c) => ({ c, score: scoreCandidate(r, c, now) }))
    .filter((x) => x.score > 0);
  // A file that's already open in a window: switch to that window instead of
  // opening it a second time (or revealing it, for "find").
  if (req.mode !== 'find') {
    const openDocs = new Map();
    for (const c of candidates) if (c.type === 'window' && c.document) openDocs.set(docPath(c.document), c);
    ranked = ranked.map((x) => {
      const w = x.c.type === 'file' && openDocs.get(x.c.path);
      return w ? { c: w, score: x.score + 0.01 } : x;
    });
    const seen = new Set();
    ranked = ranked.filter((x) => (seen.has(x.c) ? false : seen.add(x.c)));
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0] && ranked[0].score >= THRESHOLD ? ranked[0] : null;
  const close = best && ranked.find((x) => x !== best && x.c.type !== best.c.type && x.score >= THRESHOLD && best.score - x.score < 0.06);
  return { best, ranked, close: close || null };
}

// Running the file search is slow, so only do it when it could change the answer.
function needsFiles(req, cheapBest) {
  if (req.mode === 'search') return false;
  if (req.types && (req.types.has('file') || req.types.has('folder'))) return true;
  if (req.mode === 'find') return true;
  return !cheapBest || cheapBest.score < 0.9;
}

// What to do with the winner, and what to say about it.
function describe(req, hit) {
  const c = hit.c;
  const reveal = req.mode === 'find';
  switch (c.type) {
    case 'window':
      return { action: 'focus-window', say: `Switched to ${c.app}${c.title && c.title !== c.app ? ` — ${c.title}` : ''}.` };
    case 'tab':
      return { action: 'focus-tab', say: `Switched to your ${c.app} tab: ${c.title || c.host}.` };
    case 'app':
      return { action: 'open-app', say: `Opening ${c.name}.` };
    case 'project':
      return reveal ? { action: 'reveal', say: `Here's the ${c.name} project folder.` } : { action: 'open-project', say: `Opening the ${c.name} project.` };
    case 'file':
      return reveal ? { action: 'reveal', say: `Found ${c.name}. It's in ${shortDir(c.path)}.` } : { action: 'open-path', say: `Opening ${c.name}.` };
    case 'folder':
      return reveal ? { action: 'reveal', say: `Found the ${c.name} folder in ${shortDir(c.path)}.` } : { action: 'open-path', say: `Opening the ${c.name} folder.` };
    case 'site':
      return { action: 'open-url', say: `Opening ${c.name}.` };
    default:
      return { action: 'none', say: '' };
  }
}

function shortDir(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  parts.pop();
  if (parts[0] === 'Users' && parts.length >= 2) parts.splice(0, 2, '~');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || '/';
}

module.exports = { rank, describe, needsFiles, siteCandidates, scoreCandidate, hostOf, shortDir, SITES, THRESHOLD };
