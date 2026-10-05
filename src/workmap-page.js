// Renders a Work Map as a self-contained HTML page that sits next to its
// screenshots (frames/*.jpg). All content is inserted with textContent from the
// embedded JSON, so nothing from the session is ever parsed as HTML.

function renderWorkMap({ map, session }) {
  const data = {
    map,
    title: session.title,
    startedAt: session.startedAt,
    events: session.events.map((e) => ({ id: e.id, t: e.t, type: e.type, label: e.label, text: e.text, from: e.from, to: e.to, role: e.role, keys: e.keys, app: e.app, window: e.window, rect: e.rect, frame: e.frame })),
    qas: session.qas,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Work Map</title>
<style>
:root {
  --bg: #f6f7fb; --panel: #ffffff; --ink: #14203f; --muted: #5d6b8a; --line: #e3e7f0;
  --accent: #3b82f6; --accent-soft: #e8f0ff; --glow: #5ee7ff;
  --judge: #7c4dff; --judge-soft: #f0ebff;
  --limit: #b45309; --limit-soft: #fff4e5; --exception: #0f766e; --exception-soft: #e6f7f5; --stop: #c2410c; --stop-soft: #fff0e8;
  --shadow: 0 1px 2px rgba(20, 32, 63, .06), 0 8px 24px rgba(20, 32, 63, .06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1220; --panel: #151c2e; --ink: #e8edf7; --muted: #95a3c2; --line: #263049;
    --accent: #6aa5ff; --accent-soft: #1b2a47; --judge: #b39dff; --judge-soft: #261f42;
    --limit: #f5b25c; --limit-soft: #33260f; --exception: #5fd3c4; --exception-soft: #12302c; --stop: #ff9b6b; --stop-soft: #37210f;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.25);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; }
header { max-width: 1240px; margin: 0 auto; padding: 40px 24px 20px; }
.eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
.eyebrow::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: radial-gradient(circle at 40% 40%, #fff, var(--glow) 45%, var(--accent)); box-shadow: 0 0 10px var(--glow); }
h1 { font-size: 32px; line-height: 1.15; margin: 10px 0 8px; letter-spacing: -.02em; }
.summary { color: var(--muted); max-width: 760px; margin: 0; font-size: 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.chip { background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; font-size: 13px; color: var(--muted); }
.chip b { color: var(--ink); }
.chip.ok { color: #0f766e; border-color: #99e2d8; background: #e9fbf7; }
@media (prefers-color-scheme: dark) { .chip.ok { color: #5fd3c4; border-color: #1f4d47; background: #12302c; } }
main { max-width: 1240px; margin: 0 auto; padding: 8px 24px 48px; display: grid; grid-template-columns: 340px 1fr; gap: 24px; align-items: start; }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
.timeline { list-style: none; margin: 0; padding: 0; position: sticky; top: 16px; }
@media (max-width: 860px) { .timeline { position: static; } }
.timeline li { margin: 0 0 8px; }
.step-btn { width: 100%; text-align: left; display: grid; grid-template-columns: 30px 1fr; gap: 10px; align-items: start; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px; cursor: pointer; color: inherit; font: inherit; transition: border-color .15s, box-shadow .15s, transform .15s; }
.step-btn:hover { border-color: var(--accent); }
.step-btn[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.num { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; background: var(--accent-soft); color: var(--accent); }
.judgment .num { background: var(--judge-soft); color: var(--judge); }
.step-title { font-weight: 600; display: block; }
.step-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; font-size: 12px; color: var(--muted); }
.tag { border-radius: 6px; padding: 1px 7px; font-size: 11px; font-weight: 600; }
.tag.j { background: var(--judge-soft); color: var(--judge); }
.tag.g { background: var(--limit-soft); color: var(--limit); }
.detail { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); overflow: hidden; }
.moment { position: relative; background: #0b1020; }
.moment img { display: block; width: 100%; height: auto; }
.moment .ring { position: absolute; border: 3px solid var(--glow); border-radius: 10px; box-shadow: 0 0 0 4px rgba(94,231,255,.35), 0 0 24px rgba(94,231,255,.6); pointer-events: none; }
.moment .time { position: absolute; left: 12px; top: 12px; background: rgba(10,16,32,.78); color: #fff; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; }
.no-frame { padding: 48px 24px; text-align: center; color: var(--muted); background: var(--bg); }
.body { padding: 22px 24px 26px; }
.body h2 { margin: 0 0 4px; font-size: 22px; letter-spacing: -.01em; }
.action { color: var(--muted); margin: 0 0 18px; }
.block { margin: 16px 0 0; }
.label { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
.decision { font-size: 17px; font-weight: 600; }
blockquote { margin: 0; padding: 12px 16px; border-left: 4px solid var(--judge); background: var(--judge-soft); border-radius: 0 12px 12px 0; font-size: 16px; }
blockquote cite { display: block; margin-top: 6px; font-style: normal; font-size: 12px; color: var(--muted); }
.rule { padding: 12px 14px; border: 1px dashed var(--line); border-radius: 12px; font-weight: 600; }
.guards { display: grid; gap: 8px; }
.guard { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; padding: 10px 12px; border-radius: 12px; }
.guard .kind { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,.6); }
.guard.limit { background: var(--limit-soft); color: var(--limit); }
.guard.exception { background: var(--exception-soft); color: var(--exception); }
.guard.stop_and_ask { background: var(--stop-soft); color: var(--stop); }
.guard .gt { color: var(--ink); }
details { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 12px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600; }
.events { margin: 8px 0 0; padding: 0; list-style: none; font-size: 13px; color: var(--muted); }
.events li { padding: 3px 0; }
.events code { color: var(--ink); background: var(--bg); padding: 0 4px; border-radius: 4px; }
.nav { display: flex; justify-content: space-between; gap: 8px; padding: 0 24px 22px; }
.nav button { font: inherit; font-weight: 600; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 999px; padding: 7px 16px; cursor: pointer; }
.nav button:disabled { opacity: .4; cursor: default; }
section.extra { max-width: 1240px; margin: 0 auto; padding: 0 24px 64px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 860px) { section.extra { grid-template-columns: 1fr; } }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 20px 22px; box-shadow: var(--shadow); }
.card h3 { margin: 0 0 10px; font-size: 16px; }
.qa { padding: 10px 0; border-top: 1px solid var(--line); }
.qa:first-of-type { border-top: 0; }
.qa .q { font-weight: 600; }
.qa .a { color: var(--muted); margin-top: 2px; }
.qa .when { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <div class="eyebrow">Work Map</div>
  <h1 id="title"></h1>
  <p class="summary" id="summary"></p>
  <div class="chips" id="chips"></div>
</header>
<main>
  <ol class="timeline" id="timeline"></ol>
  <article class="detail" id="detail"></article>
</main>
<section class="extra">
  <div class="card"><h3>How the apprentice explained it back</h3><p id="teachback"></p></div>
  <div class="card"><h3>Questions it asked</h3><div id="qas"></div></div>
</section>
<script type="application/json" id="data">${json}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const M = D.map;
const ev = new Map(D.events.map((e) => [e.id, e]));
const qa = new Map(D.qas.map((q) => [q.id, q]));
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const clock = (ms) => { const s = Math.round(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const KIND = { limit: 'Limit', exception: 'Exception', stop_and_ask: 'Stop and ask' };

$('title').textContent = M.title || D.title;
$('summary').textContent = M.summary;
document.title = (M.title || D.title) + ' · Work Map';
const judg = M.steps.filter((s) => s.is_judgment).length;
const guards = M.steps.reduce((n, s) => n + s.guardrails.length, 0);
const last = D.events.length ? D.events[D.events.length - 1].t : 0;
const chips = [['', M.steps.length + ' steps'], ['', judg + ' judgment calls'], ['', guards + ' guardrails'], ['', 'Recorded ' + new Date(D.startedAt).toLocaleDateString() + ' · ' + clock(last)]];
if (M.confirmed) chips.push(['ok', 'Confirmed by the expert']);
for (const [cls, t] of chips) $('chips').append(el('span', 'chip ' + cls, t));

function describe(e) {
  const v = (x) => (x === '1' ? 'on' : x === '0' ? 'off' : x === '' ? '(empty)' : x);
  if (e.type === 'edit') return ['Changed ', e.label, ': ' + v(e.from) + ' → ' + v(e.to)];
  if (e.type === 'click') return ['Clicked ', e.label, ''];
  if (e.type === 'shortcut') return ['Pressed ', e.keys, ''];
  if (e.type === 'say') return ['Said ', '“' + e.text + '”', ''];
  return ['Opened ', e.window || e.app, ''];
}

function moment(step) {
  const ids = step.event_ids.map((id) => ev.get(id)).filter(Boolean);
  return ids.find((e) => e.frame && e.rect) || ids.find((e) => e.frame) || ids[0] || null;
}

let current = 0;
const buttons = [];
M.steps.forEach((s, i) => {
  const li = el('li', s.is_judgment ? 'judgment' : '');
  const b = el('button', 'step-btn');
  b.type = 'button';
  b.append(el('span', 'num', String(i + 1)));
  const txt = el('span');
  txt.append(el('span', 'step-title', s.title));
  const meta = el('span', 'step-meta');
  const m = moment(s);
  if (m) meta.append(el('span', '', clock(m.t)));
  if (s.is_judgment) meta.append(el('span', 'tag j', 'Judgment'));
  if (s.guardrails.length) meta.append(el('span', 'tag g', s.guardrails.length + (s.guardrails.length > 1 ? ' guardrails' : ' guardrail')));
  txt.append(meta);
  b.append(txt);
  b.addEventListener('click', () => show(i));
  li.append(b);
  $('timeline').append(li);
  buttons.push(b);
});

function show(i) {
  current = i;
  buttons.forEach((b, j) => b.setAttribute('aria-current', String(j === i)));
  const s = M.steps[i];
  const d = $('detail');
  d.replaceChildren();

  const m = moment(s);
  if (m && m.frame) {
    const box = el('div', 'moment');
    const img = el('img');
    img.src = m.frame.file;
    img.alt = 'Screen at ' + clock(m.t);
    box.append(img);
    if (m.rect && m.frame.display) {
      const f = m.frame.display, pad = 6;
      const r = el('div', 'ring');
      r.style.left = ((m.rect.x - pad - f.x) / f.w) * 100 + '%';
      r.style.top = ((m.rect.y - pad - f.y) / f.h) * 100 + '%';
      r.style.width = ((m.rect.w + pad * 2) / f.w) * 100 + '%';
      r.style.height = ((m.rect.h + pad * 2) / f.h) * 100 + '%';
      box.append(r);
    }
    box.append(el('span', 'time', 'Screen moment · ' + clock(m.t)));
    d.append(box);
  } else {
    d.append(el('div', 'no-frame', 'No screenshot for this step'));
  }

  const body = el('div', 'body');
  body.append(el('div', 'label', 'Step ' + (i + 1) + ' of ' + M.steps.length));
  body.append(el('h2', '', s.title));
  body.append(el('p', 'action', s.action));
  if (s.decision) {
    const b = el('div', 'block');
    b.append(el('div', 'label', 'Decision'), el('div', 'decision', s.decision));
    body.append(b);
  }
  if (s.reason) {
    const b = el('div', 'block');
    b.append(el('div', 'label', 'Why'));
    const q = el('blockquote', '', s.reason);
    const src = s.reason_qa_id != null ? qa.get(s.reason_qa_id) : null;
    const said = s.reason_event_id != null ? ev.get(s.reason_event_id) : null;
    if (src) q.append(el('cite', '', 'The expert, ' + (src.phase === 'live' ? 'asked while working' : 'in the debrief') + ' at ' + clock(src.t)));
    else if (said) q.append(el('cite', '', 'The expert, explaining while working at ' + clock(said.t)));
    b.append(q);
    body.append(b);
  }
  if (s.rule) {
    const b = el('div', 'block');
    b.append(el('div', 'label', 'Rule'), el('div', 'rule', s.rule));
    body.append(b);
  }
  if (s.guardrails.length) {
    const b = el('div', 'block');
    b.append(el('div', 'label', 'Guardrails'));
    const g = el('div', 'guards');
    for (const gr of s.guardrails) {
      const row = el('div', 'guard ' + gr.kind);
      row.append(el('span', 'kind', KIND[gr.kind] || gr.kind), el('span', 'gt', gr.text));
      g.append(row);
    }
    b.append(g);
    body.append(b);
  }
  const evs = s.event_ids.map((id) => ev.get(id)).filter(Boolean);
  if (evs.length) {
    const det = el('details');
    det.append(el('summary', '', 'What happened on screen (' + evs.length + ')'));
    const ul = el('ul', 'events');
    for (const e of evs) {
      const [a, b, c] = describe(e);
      const li = el('li', '', clock(e.t) + '  ' + a);
      li.append(el('code', '', b || ''), document.createTextNode(c));
      ul.append(li);
    }
    det.append(ul);
    body.append(det);
  }
  d.append(body);

  const nav = el('div', 'nav');
  const prev = el('button', '', '← Previous');
  const next = el('button', '', 'Next →');
  prev.disabled = i === 0;
  next.disabled = i === M.steps.length - 1;
  prev.onclick = () => show(i - 1);
  next.onclick = () => show(i + 1);
  nav.append(prev, next);
  d.append(nav);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') show(Math.min(M.steps.length - 1, current + 1));
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') show(Math.max(0, current - 1));
});

$('teachback').textContent = M.teach_back;
for (const q of D.qas.filter((x) => x.phase !== 'teach-back')) {
  const row = el('div', 'qa');
  row.append(el('div', 'when', (q.phase === 'live' ? 'While working' : 'Debrief') + ' · ' + clock(q.t)), el('div', 'q', q.question), el('div', 'a', q.answer || '(skipped)'));
  $('qas').append(row);
}
if (M.steps.length) show(0);
</script>
</body>
</html>
`;
}

module.exports = { renderWorkMap };
