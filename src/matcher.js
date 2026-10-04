// Turns a request like "where's the share button?" into the best matching
// on-screen element. Pure functions — see test/matcher.test.js.

const FILLER = new Set([
  'a', 'an', 'the', 'is', 'are', 'where', 'wheres', "where's", 'whats', 'what', 'find', 'show', 'me', 'point',
  'to', 'at', 'can', 'you', 'please', 'pls', 'i', 'want', 'need', 'click', 'press', 'tap', 'hit', 'go',
  'button', 'buttons', 'btn', 'link', 'icon', 'tab', 'menu', 'option', 'thing', 'one', 'that', 'this',
  'my', 'for', 'on', 'of', 'it', 'how', 'do', 'get', 'open', 'hey', 'buddy', 'say', 'says', 'called', 'labelled', 'labeled',
]);

// Words in the request that hint at a type of control.
const ROLE_HINTS = {
  button: ['AXButton', 'AXMenuButton', 'AXPopUpButton'],
  link: ['AXLink'],
  tab: ['AXTab', 'AXRadioButton'],
  menu: ['AXMenuBarItem', 'AXMenuButton', 'AXPopUpButton'],
  checkbox: ['AXCheckBox'],
  search: ['AXSearchField', 'AXTextField'],
  field: ['AXTextField', 'AXSearchField', 'AXComboBox'],
  box: ['AXTextField', 'AXSearchField', 'AXCheckBox'],
};

const GENERIC_HINTS = new Set(['button', 'link', 'tab', 'menu', 'checkbox', 'field', 'box']);

// How "button-like" each role is. Plain text and images rank below real controls.
const ROLE_WEIGHT = {
  AXButton: 1, AXMenuButton: 1, AXPopUpButton: 0.98, AXLink: 0.97, AXTab: 0.97, AXRadioButton: 0.95,
  AXCheckBox: 0.95, AXMenuBarItem: 0.93, AXSearchField: 0.93, AXTextField: 0.9, AXComboBox: 0.9,
  AXDisclosureTriangle: 0.9, AXSlider: 0.85, AXIncrementor: 0.85, AXColorWell: 0.85,
  AXCell: 0.8, AXRow: 0.78, AXImage: 0.75, AXStaticText: 0.72,
};

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseQuery(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  const roleHints = new Set();
  for (const w of words) for (const r of ROLE_HINTS[w] || []) roleHints.add(r);
  // Words like "checkbox" describe the kind of control, not its label.
  let terms = words.filter((w) => !FILLER.has(w) && !ROLE_HINTS[w]);
  // "find the search box" -> keep "search" even though it's also a hint.
  if (!terms.length) terms = words.filter((w) => ROLE_HINTS[w] && !GENERIC_HINTS.has(w));
  return { phrase: terms.join(' '), terms, roleHints };
}

// Edit distance where swapping two neighbouring letters ("sned") counts as one typo.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - editDistance(a, b) / max : 0;
}

// 0..1 for how well a label matches the query text.
function textScore(query, label) {
  const q = query.phrase;
  const l = normalize(label);
  if (!q || !l) return 0;
  if (l === q) return 1;

  const lWords = l.split(' ');
  if (lWords[0] === query.terms[0] && l.startsWith(q)) return 0.92;
  if (l.startsWith(q)) return 0.88;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l)) return 0.85 - Math.min(0.2, (l.length - q.length) / 200);

  // Per-word: each query term finds its best (fuzzy) partner in the label.
  let sum = 0;
  for (const t of query.terms) {
    let best = 0;
    for (const w of lWords) {
      let s = similarity(t, w);
      if (w.startsWith(t) && t.length >= 3) s = Math.max(s, 0.85);
      if (s > best) best = s;
    }
    sum += best >= 0.7 ? best : 0;
  }
  const coverage = sum / query.terms.length;
  // Labels much longer than the request are probably paragraphs, not buttons.
  const lengthPenalty = Math.min(0.25, Math.max(0, lWords.length - query.terms.length * 2) * 0.03);
  return Math.max(0, coverage * 0.8 - lengthPenalty, similarity(q, l) * 0.75);
}

function rankElements(text, elements) {
  const query = parseQuery(text);
  if (!query.phrase) return { query, ranked: [] };

  const ranked = elements
    .map((el) => {
      let score = textScore(query, el.label) * (ROLE_WEIGHT[el.role] || 0.7);
      if (query.roleHints.size && query.roleHints.has(el.role)) score += 0.08;
      return { el, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.el.y - b.el.y);

  return { query, ranked };
}

const MATCH_THRESHOLD = 0.5;

function findBest(text, elements) {
  const { query, ranked } = rankElements(text, elements);
  const best = ranked[0] && ranked[0].score >= MATCH_THRESHOLD ? ranked[0] : null;
  const seen = new Set();
  const suggestions = [];
  for (const r of ranked) {
    const key = normalize(r.el.label);
    if (best && key === normalize(best.el.label)) continue;
    if (seen.has(key) || r.el.role === 'AXStaticText') continue;
    seen.add(key);
    suggestions.push(r.el.label);
    if (suggestions.length >= 3) break;
  }
  return { query, match: best ? best.el : null, score: best ? best.score : 0, suggestions };
}

module.exports = { parseQuery, textScore, rankElements, findBest, normalize, MATCH_THRESHOLD };
