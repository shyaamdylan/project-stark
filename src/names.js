// Fixing names that speech-to-text gets wrong ("Piano Scrap", "Pianist Scribe"
// for PianoScribe) using names the assistant already knows: your project
// folders, apps and learned skills. Only close matches to those names change,
// so ordinary words are left alone.

const fs = require('fs');
const os = require('os');
const path = require('path');

const squash = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Is `heard` (squashed) close enough to `name` (squashed) to be a mishearing?
function closeTo(heard, name) {
  if (heard.length < 6 || name.length < 6) return false;
  if (heard.slice(0, 3) !== name.slice(0, 3)) return false;
  const sim = 1 - distance(heard, name) / Math.max(heard.length, name.length);
  return sim >= (name.length >= 10 ? 0.72 : 0.8);
}

// Replace misheard runs of 1 to 3 words with the known name they're closest to.
// Returns { text, fixes: [[heard, name]] }.
function correctNames(text, names) {
  // Only distinctive names (PianoScribe, project-stark, Visual Studio Code):
  // an ordinary word like "Screenshots" is never forced onto what was said.
  const distinctive = (n) => /[a-z][A-Z]|[-_\d]|\s/.test(n);
  const known = [...new Set(names)].filter(distinctive).map((n) => ({ n, s: squash(n) })).filter((x) => x.s.length >= 6);
  if (!known.length) return { text, fixes: [] };
  const tokens = String(text).split(/(\s+|\/)/); // keep the spaces and slashes
  const words = tokens.map((t, i) => ({ t, i })).filter((x) => x.t.trim() && x.t !== '/');
  const fixes = [];
  const used = new Set();
  for (const size of [3, 2, 1]) {
    for (let k = 0; k + size <= words.length; k++) {
      const run = words.slice(k, k + size);
      if (run.some((w) => used.has(w.i))) continue;
      // A name never spans a slash: "documents/Pianist" is two parts of a path.
      if (run.some((w, m) => m > 0 && tokens.slice(run[m - 1].i + 1, w.i).includes('/'))) continue;
      const phrase = run.map((w) => w.t).join(' ');
      const heard = squash(phrase);
      let best = null;
      for (const x of known) {
        // Already right: only worth rewriting when it was split ("Piano Scribe").
        if (heard === x.s) {
          best = size > 1 ? x : null;
          break;
        }
        if (closeTo(heard, x.s) && (!best || distance(heard, x.s) < distance(heard, best.s))) best = x;
      }
      if (!best) continue;
      const trail = /[^a-z0-9]+$/i.exec(run[run.length - 1].t);
      tokens[run[0].i] = best.n + (trail ? trail[0] : '');
      for (let m = 1; m < run.length; m++) tokens[run[m].i] = '';
      // Drop the spaces inside the replaced run.
      for (let p = run[0].i + 1; p < run[run.length - 1].i; p++) if (!tokens[p].trim()) tokens[p] = '';
      run.forEach((w) => used.add(w.i));
      fixes.push([phrase, best.n]);
    }
  }
  return { text: tokens.join('').replace(/\s{2,}/g, ' ').trim(), fixes };
}

// Names worth knowing: folders where people keep projects, and installed apps.
// Refreshed at most every few minutes.
let cache = null;
function knownNames({ home = os.homedir(), extra = [] } = {}) {
  if (!cache || Date.now() - cache.at > 5 * 60 * 1000) {
    const names = [];
    const dirs = ['Documents', 'Desktop', 'Developer', 'Projects', 'code', 'Code', 'src', 'GitHub', 'repos'].map((d) => path.join(home, d));
    for (const d of [...dirs, '/Applications', '/System/Applications']) {
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory()) names.push(e.name.replace(/\.app$/, ''));
        }
      } catch {}
    }
    cache = { at: Date.now(), names };
  }
  return [...cache.names, ...extra];
}

module.exports = { correctNames, knownNames, distance, closeTo };
