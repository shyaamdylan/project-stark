// Skills hub: every Work Map the apprentice has learned. The sidebar lists them
// by date; the main pane shows one as a reading column: how Friday understands
// it, each step with its screen moment, decision, the expert's reason and the
// guardrails, and the questions she asked. All text goes in with textContent.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const svg = (paths) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
};
const clock = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const KIND = { limit: 'Limit', exception: 'Exception', stop_and_ask: 'Stop and ask' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let skills = [];
let current = null; // the summary from the list
let detail = null; // the full skill (map, events, Q&A)

// ---------- sidebar ----------

function groupOf(ms) {
  const day = 24 * 60 * 60 * 1000;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return 'Today';
  if (ms >= start.getTime() - day) return 'Yesterday';
  if (ms >= start.getTime() - 7 * day) return 'Previous 7 days';
  if (ms >= start.getTime() - 30 * day) return 'Previous 30 days';
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('list');
  list.replaceChildren();
  let group = null;
  for (const s of skills.filter((x) => !q || `${x.title} ${x.summary}`.toLowerCase().includes(q))) {
    const g = groupOf(s.createdAt);
    if (g !== group) {
      group = g;
      list.append(el('div', 'group', g));
    }
    const b = el('button', `item${current && s.id === current.id ? ' active' : ''}`);
    b.type = 'button';
    const t = el('div', 't');
    t.append(el('span', '', s.title));
    if (!s.page) t.append(el('span', 'pill', 'Unfinished'));
    b.append(t, el('div', 'm', s.page ? `${plural(s.steps, 'step')} · ${plural(s.judgments, 'judgment call')}` : 'Recording not finished'));
    b.addEventListener('click', () => select(s.id));
    list.append(b);
  }
  $('count').textContent = skills.length ? `${plural(skills.length, 'skill')} learned` : 'No skills yet';
}

// ---------- one skill ----------

async function select(id) {
  current = skills.find((s) => s.id === id) || null;
  renderList();
  $('empty').classList.toggle('hidden', skills.length > 0);
  $('skill').classList.toggle('hidden', !current);
  $('actions').classList.toggle('hidden', !current);
  if (!current) {
    $('top-title').textContent = '';
    return;
  }
  detail = current.page ? await window.hub.skill(current.id) : null;
  if (!current || current.id !== id) return; // picked another meanwhile
  renderSkill();
  $('scroll').scrollTop = 0;
}

function renderSkill() {
  const s = current;
  const M = detail && detail.map;
  $('top-title').textContent = s.title;
  $('title').textContent = s.title;
  $('summary').textContent = (M && M.summary) || s.summary || '';
  $('learn').disabled = $('run').disabled = !s.page;

  const chips = $('chips');
  chips.replaceChildren();
  const chip = (cls, text, icon) => {
    const c = el('span', `chip ${cls}`);
    if (icon) c.append(icon);
    c.append(document.createTextNode(text));
    chips.append(c);
  };
  chip('', plural(s.steps, 'step'));
  if (s.judgments) chip('j', plural(s.judgments, 'judgment call'));
  if (s.guardrails) chip('g', plural(s.guardrails, 'guardrail'));
  chip('', `Recorded ${new Date(s.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
  if (s.confirmed) chip('ok', 'Confirmed by the expert', svg(['m5 10.5 3 3 7-7']));

  if (!M) {
    for (const id of ['teachback-card', 'before', 'open-card', 'qas', 'qas-title']) $(id).classList.add('hidden');
    $('steps').replaceChildren(el('li', 'lede', 'This recording was never finished, so there is no Work Map yet.'));
    return;
  }

  // How she understands it, and whether the expert said yes.
  $('teachback-card').classList.toggle('hidden', !M.teach_back);
  $('teachback').textContent = M.teach_back || '';
  $('confirmed').classList.toggle('hidden', !M.confirmed);

  // What the task relies on.
  const before = $('before');
  before.replaceChildren();
  if ((M.prerequisites || []).length) {
    before.append(el('div', 'card-label', 'Before you start'));
    const ul = el('ul');
    for (const t of M.prerequisites) ul.append(el('li', '', t));
    before.append(ul);
  }
  before.classList.toggle('hidden', !before.children.length);

  renderSteps(M);

  const open = M.open_questions || [];
  $('open-card').classList.toggle('hidden', !open.length);
  $('open-qs').replaceChildren(...open.map((t) => el('li', '', t)));

  renderQas();
}

function renderSteps(M) {
  const ev = new Map(detail.events.map((e) => [e.id, e]));
  const qa = new Map(detail.qas.map((q) => [q.id, q]));
  const list = $('steps');
  list.replaceChildren();
  M.steps.forEach((st, i) => {
    const li = el('li', `step${st.is_judgment ? ' judgment' : ''}${i === 0 ? ' open' : ''}`);
    li.append(el('span', 'num', String(i + 1)));

    const head = el('button', 'step-head');
    head.type = 'button';
    const main = el('div', 'step-main');
    main.append(el('div', 'step-title', st.title), el('div', 'step-action', st.action));
    const tags = el('div', 'tags');
    const m = momentOf(st, ev);
    if (m) tags.append(el('span', 'tag time', clock(m.t)));
    if (st.kind === 'go') tags.append(el('span', 'tag', 'Get to'));
    if (st.inferred) tags.append(el('span', 'tag', 'Filled a gap'));
    if (st.is_judgment) tags.append(el('span', 'tag j', 'Judgment call'));
    if (st.guardrails.length) tags.append(el('span', 'tag g', plural(st.guardrails.length, 'guardrail')));
    if (tags.children.length) main.append(tags);
    const chev = svg(['m8 5 5 5-5 5']);
    chev.classList.add('chev');
    head.append(main, chev);
    head.addEventListener('click', () => li.classList.toggle('open'));

    const body = el('div', 'step-body');
    const inner = el('div');
    inner.append(stepDetail(st, m, ev, qa));
    body.append(inner);
    li.append(head, body);
    list.append(li);
  });
}

// The screen moment for a step: an event with a screenshot and a spot, if any.
function momentOf(st, ev) {
  const ids = (st.event_ids || []).map((id) => ev.get(id)).filter(Boolean);
  return ids.find((e) => e.frame && e.frame.url && e.rect) || ids.find((e) => e.frame && e.frame.url) || ids[0] || null;
}

function field(label, node) {
  const d = el('div');
  d.append(el('div', 'field-label', label), node);
  return d;
}

function stepDetail(st, m, ev, qa) {
  const d = el('div', 'detail');
  if (m && m.frame && m.frame.url) {
    const box = el('div', 'moment');
    const img = el('img');
    img.src = m.frame.url;
    img.alt = `The expert's screen at ${clock(m.t)}`;
    box.append(img);
    const f = m.frame.display;
    if (m.rect && f) {
      const pad = 6;
      const r = el('div', 'ring');
      r.style.left = `${((m.rect.x - pad - f.x) / f.w) * 100}%`;
      r.style.top = `${((m.rect.y - pad - f.y) / f.h) * 100}%`;
      r.style.width = `${((m.rect.w + pad * 2) / f.w) * 100}%`;
      r.style.height = `${((m.rect.h + pad * 2) / f.h) * 100}%`;
      box.append(r);
    }
    box.append(el('span', 'when', `Screen moment · ${clock(m.t)}`));
    d.append(box);
  }
  if (st.kind === 'go' && st.destination) {
    d.append(field('Get to', el('div', 'rule', `${st.destination.name}${st.destination.url ? ` · ${st.destination.url}` : ''}`)));
  }
  if (st.decision) d.append(field('Decision', el('div', 'decision', st.decision)));
  if (st.reason) {
    const q = el('blockquote', '', `“${st.reason}”`);
    const src = st.reason_qa_id != null ? qa.get(st.reason_qa_id) : null;
    const said = st.reason_event_id != null ? ev.get(st.reason_event_id) : null;
    if (src) q.append(el('cite', '', `The expert, ${src.phase === 'live' ? 'asked while working' : 'in the debrief'} at ${clock(src.t)}`));
    else if (said) q.append(el('cite', '', `The expert, explaining while working at ${clock(said.t)}`));
    d.append(field('Why', q));
  }
  if (st.rule) d.append(field('Rule', el('div', 'rule', st.rule)));
  if (st.guardrails.length) {
    const g = el('div', 'guards');
    for (const gr of st.guardrails) {
      const row = el('div', `guard ${gr.kind}`);
      const text = el('div');
      text.append(document.createTextNode(gr.text));
      const src = gr.qa_id != null ? qa.get(gr.qa_id) : null;
      if (src) text.append(el('span', 'src', `From ${src.phase === 'live' ? 'a question while working' : 'the debrief'} at ${clock(src.t)}`));
      row.append(el('span', 'kind', KIND[gr.kind] || gr.kind), text);
      g.append(row);
    }
    d.append(field('Guardrails', g));
  }
  const evs = (st.event_ids || []).map((id) => ev.get(id)).filter(Boolean);
  if (evs.length) {
    const det = el('details', 'events');
    det.append(el('summary', '', `What happened on screen (${evs.length})`));
    const ul = el('ul');
    for (const e of evs) {
      const li = el('li');
      const [a, b, c] = describe(e);
      li.append(document.createTextNode(`${clock(e.t)}  ${a}`), el('b', '', b || ''), document.createTextNode(c));
      ul.append(li);
    }
    det.append(ul);
    d.append(det);
  }
  return d;
}

function describe(e) {
  const v = (x) => (x === '1' ? 'on' : x === '0' ? 'off' : x === '' ? '(empty)' : x);
  if (e.type === 'edit') return ['Changed ', e.label, `: ${v(e.from)} → ${v(e.to)}`];
  if (e.type === 'click') return ['Clicked ', e.label, ''];
  if (e.type === 'shortcut') return ['Pressed ', e.keys, ''];
  if (e.type === 'say') return ['Said ', `“${e.text}”`, ''];
  return ['Opened ', e.window || e.app, ''];
}

function renderQas() {
  const box = $('qas');
  box.replaceChildren();
  const asked = detail.qas.filter((q) => q.phase !== 'teach-back');
  $('qas').classList.toggle('hidden', !asked.length);
  $('qas-title').classList.toggle('hidden', !asked.length);
  for (const q of asked) {
    const row = el('div', 'qa');
    const qq = el('div', 'q');
    qq.append(el('span', 'mini-orb'), el('span', '', q.question));
    row.append(qq, el('div', 'a', q.answer || '(no answer)'), el('div', 'meta', `${q.phase === 'live' ? 'Asked while working' : 'Debrief'} · ${clock(q.t)}`));
    box.append(row);
  }
}

// ---------- loading, actions ----------

async function load(selectId) {
  skills = await window.hub.list();
  const keep = selectId || (current && current.id) || (skills[0] && skills[0].id);
  await select(keep);
}

function closeMenu() {
  $('menu').classList.add('hidden');
  $('more').setAttribute('aria-expanded', 'false');
}

$('search').addEventListener('input', renderList);
$('teach').addEventListener('click', () => window.hub.teach());
$('teach-empty').addEventListener('click', () => window.hub.teach());
$('learn').addEventListener('click', () => current && current.page && window.hub.learn(current.id));
$('run').addEventListener('click', () => current && current.page && window.hub.run(current.id));
$('more').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('menu').classList.toggle('hidden') === false;
  $('more').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
  if (e.key === 'f' && e.metaKey) {
    e.preventDefault();
    $('search').focus();
  }
});
$('export').addEventListener('click', () => current && current.page && window.hub.exportForAgents(current.id));
$('open').addEventListener('click', () => current && current.page && window.hub.openExternal(current.id));
$('reveal').addEventListener('click', () => current && window.hub.reveal(current.id));
$('delete').addEventListener('click', async () => {
  if (!current || !confirm(`Move "${current.title}" to the Trash?`)) return;
  await window.hub.remove(current.id);
  current = null;
  load();
});
// The skill's title shows in the bar once its big heading has scrolled away.
$('scroll').addEventListener('scroll', () => $('scroll').parentElement.querySelector('.topbar').classList.toggle('scrolled', $('scroll').scrollTop > 60));
window.hub.onChanged((id) => load(id));
load();
