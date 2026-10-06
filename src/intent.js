// Works out what kind of request the user typed: tidy the workspace, switch to
// something already open, open/find a file, project or website, or point at a
// button on screen (the original feature). Pure functions — see test/intent.test.js.

const { normalize } = require('./matcher');

// Words that say which *kind* of thing is wanted. They're removed from the
// search phrase ("the budget spreadsheet" -> "budget").
const TYPE_WORDS = {
  file: ['file', 'files', 'document', 'documents', 'doc', 'docs', 'pdf', 'spreadsheet', 'spreadsheets', 'sheet', 'excel',
    'deck', 'slides', 'presentation', 'keynote', 'powerpoint', 'image', 'photo', 'picture', 'screenshot', 'video', 'recording'],
  folder: ['folder', 'folders', 'directory', 'dir'],
  project: ['project', 'repo', 'repository', 'codebase'],
  site: ['website', 'site', 'webpage', 'url'],
  app: ['app', 'application'],
  window: ['window', 'windows', 'tab', 'tabs'],
};

// Extensions implied by a type word, so "the budget spreadsheet" prefers .xlsx.
const EXTENSIONS = {
  pdf: ['pdf'],
  spreadsheet: ['xlsx', 'xls', 'numbers', 'csv'], spreadsheets: ['xlsx', 'xls', 'numbers', 'csv'],
  sheet: ['xlsx', 'xls', 'numbers', 'csv'], excel: ['xlsx', 'xls', 'csv'],
  deck: ['key', 'pptx', 'ppt', 'pdf'], slides: ['key', 'pptx', 'ppt', 'pdf'], presentation: ['key', 'pptx', 'ppt', 'pdf'],
  keynote: ['key'], powerpoint: ['pptx', 'ppt'],
  image: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp'], photo: ['png', 'jpg', 'jpeg', 'heic'],
  picture: ['png', 'jpg', 'jpeg', 'heic'], screenshot: ['png', 'jpg'],
  video: ['mp4', 'mov', 'm4v'], recording: ['mp4', 'mov', 'm4a'],
  document: ['docx', 'doc', 'pages', 'pdf', 'txt', 'md', 'rtf'], doc: ['docx', 'doc', 'pages', 'pdf', 'txt', 'md'],
};

const FILLER = new Set([
  'a', 'an', 'the', 'my', 'me', 'please', 'pls', 'can', 'could', 'you', 'i', 'want', 'to', 'up', 'for', 'of', 'on', 'in',
  'that', 'this', 'it', 'some', 'called', 'named', 'with', 'from', 'jarvis', 'friday', 'hey', 'ok', 'okay', 'again', 'now', 'just',
  'quickly', 'real', 'quick', 'last', 'latest', 'recent', 'one', 'thing', 'where', 'is', 'are', 'did', 'put', 'was', 'saved',
]);

// Things that only make sense as on-screen controls: send these to the pointer.
const UI_WORDS = /\b(button|buttons|btn|checkbox|toggle|dropdown|menu|menus|icon|field|text box|search box|switch button|slider)\b/;

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  web: 'https://www.google.com/search?q=',
  internet: 'https://www.google.com/search?q=',
  youtube: 'https://www.youtube.com/results?search_query=',
  github: 'https://github.com/search?q=',
  amazon: 'https://www.amazon.com/s?k=',
  maps: 'https://www.google.com/maps/search/',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=',
};

const WORKSPACE = /\b(workspace|windows|window|desktop|desktops|screen|mess|everything)\b/;

// Either name wakes the assistant: "Jarvis, open slack" / "hey Friday, stop".
const WAKE = /^\s*(?:hey|ok|okay)?[\s,]*(?:jarvis|friday)\b[\s,:.!]*/i;

function stripWake(text) {
  return String(text || '').replace(WAKE, '').trim();
}

// "stop", "jarvis stop", "friday, stop listening", "never mind", "shut up".
const STOP = /^(?:(?:please|ok|okay) )?(?:stop|stop (?:it|that|listening|talking|now|please)|cancel|cancel that|never ?mind|nevermind|be quiet|quiet|shut up|shush|hush|enough|that s all|thats all|go to sleep|sleep|abort)(?: (?:jarvis|friday))?$/;

function isStop(text) {
  return STOP.test(normalize(stripWake(text)));
}

function classify(rawText) {
  const raw = stripWake(rawText);
  const t = normalize(raw);
  if (!t) return { kind: 'point', text: raw };
  if (STOP.test(t)) return { kind: 'stop' };

  // --- workspace commands ---
  if (/^(undo|undo (that|it|the (organi[sz]\w*|clean ?up|layout))|put (it|them|everything|my windows) back|restore (my )?(windows|workspace|layout))$/.test(t)) {
    return { kind: 'undo' };
  }
  const cleanup = /\b(clean ?up|clear (out|up)?|declutter|close (all )?(the )?(irrelevant|unused|other|extra|distracting|unneeded|unnecessary|old)\b)/.test(t);
  const organise = /\b(organi[sz]\w*|tidy|arrange|sort out|tile|set ?up|focus mode|get me focused)\b/.test(t);
  if ((cleanup || organise) && (WORKSPACE.test(t) || /\b(for|focus|keep|keeping)\b/.test(t) || /^(tidy|clean ?up|declutter)( up)?$/.test(t))) {
    return { kind: 'organize', cleanup, focus: focusOf(t) };
  }

  // --- explicit web search: "search youtube for lofi", "google best pizza" ---
  let m = t.match(/^(?:search|look up|google)(?: (google|the web|web|internet|youtube|github|amazon|maps|wikipedia))?(?: for)? (.+?)(?: on (google|youtube|github|amazon|maps|wikipedia))?$/);
  if (m && !UI_WORDS.test(t)) {
    const engine = (m[3] || (m[1] || 'google').replace('the web', 'web')).trim();
    if (/^(?:search|look up)\b/.test(t) && /\b(file|files|folder|document|doc|docs|pdf|project|repo)\b/.test(t)) {
      // "search for the budget file" is a file find, not a web search.
    } else {
      return { kind: 'launch', mode: 'search', engine, url: SEARCH_ENGINES[engine] + encodeURIComponent(m[2]), query: m[2] };
    }
  }

  // --- verbs that pick a mode ---
  let mode = null;
  let rest = t;
  const VERBS = [
    ['switch', /^(?:switch|swap|flip|jump|change|go back|get back|back|take me back) to /],
    ['switch', /^(?:bring up|focus(?: on)?|show me my|show my|return to) /],
    ['find', /^(?:find|locate|where(?:s| is| are| did i (?:put|save))|show me where|reveal|search(?: for)?|look for) /],
    ['open', /^(?:open|launch|start|run|load|pull up|go to|visit|take me to|show me|show|work on|continue|resume|play) /],
  ];
  for (const [name, re] of VERBS) {
    const hit = rest.match(re);
    if (hit) { mode = name; rest = rest.slice(hit[0].length); break; }
  }
  // "reveal X in finder" / "show X in finder" are finds.
  if (/ in finder$/.test(rest)) { mode = 'find'; rest = rest.replace(/ in finder$/, ''); }

  const words = rest.split(' ').filter(Boolean);
  const types = new Set();
  const extensions = new Set();
  for (const w of words) {
    for (const [type, list] of Object.entries(TYPE_WORDS)) if (list.includes(w)) types.add(type);
    for (const e of EXTENSIONS[w] || []) extensions.add(e);
  }
  // An explicit file name like "report.pdf" or a web address like "github.com".
  const literal = raw.match(/([\w\-.]+\.(pdf|docx?|xlsx?|csv|pptx?|key|pages|numbers|txt|md|png|jpe?g|heic|mov|mp4|zip))\b/i);
  if (literal) { types.add('file'); extensions.add(literal[2].toLowerCase()); }
  const url = raw.match(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|uk|edu|gov|me|tv|so|gg|xyz)(?:\/\S*)?)\b/i);
  if (url && !literal) types.add('site');

  const litExt = literal ? literal[2].toLowerCase() : null;
  const query = words
    .filter((w) => !FILLER.has(w) && w !== litExt && !Object.values(TYPE_WORDS).some((l) => l.includes(w)))
    .join(' ');

  // No verb and it smells like a UI control (or nothing else): it's the pointer.
  if (UI_WORDS.test(t) && !types.has('file') && !types.has('project') && !types.has('folder')) return { kind: 'point', text: raw };
  if (!mode) {
    if (url) return { kind: 'launch', mode: 'open', query: url[1], types, extensions, url: withScheme(url[1]) };
    // Bare words ("share", "settings tab") stay with the original pointing feature,
    // but can still fall back to opening something if nothing on screen matches.
    return { kind: 'point', text: raw, fallback: query ? { kind: 'launch', mode: 'open', query, types, extensions } : null };
  }
  if (!query && !url) return { kind: 'point', text: raw };

  const req = { kind: 'launch', mode, query: query || url[1], types, extensions };
  if (url) req.url = withScheme(url[1]);
  // "where's the share button" was handled above; "where's export" could be either,
  // so try the screen first and fall back to files.
  if (mode === 'find' && !types.size) return { kind: 'point', text: raw, fallback: req };
  return req;
}

function withScheme(u) {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

// "organise my workspace for coding" -> "coding"; "keep safari and code" -> "safari code".
function focusOf(t) {
  const m = t.match(/\b(?:for|around|with|keep(?:ing)?|except|but keep|on)\b (.+)$/);
  let words = (m ? m[1] : t.replace(/\b(organi[sz]e|tidy|arrange|sort out|tile|set ?up|clean ?up|clear|declutter|close|my|the|all|irrelevant|unused|other|extra|distracting|unneeded|unnecessary|old|up|out)\b/g, ' '))
    .split(' ')
    .filter((w) => w && !WORKSPACE.test(w) && !/^(organi[sz]|tidied|arranged|cleaned)/.test(w) && !['and', 'my', 'the', 'workspace', 'only', 'open', 'please', 'jarvis', 'friday', 'stuff', 'things', 'focus', 'mode', 'get', 'me', 'focused', 'for', 'a', 'to'].includes(w));
  // "coding workspace" / "writing setup" -> the word before "workspace" is the focus.
  return words.join(' ');
}

module.exports = { classify, focusOf, isStop, stripWake, SEARCH_ENGINES };
