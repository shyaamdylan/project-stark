// Skills hub: every Work Map the apprentice has learned, and its tutorial page.

const $ = (id) => document.getElementById(id);
let skills = [];
let current = null;

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('list');
  list.replaceChildren();
  for (const s of skills.filter((x) => !q || `${x.title} ${x.summary}`.toLowerCase().includes(q))) {
    const li = document.createElement('li');
    if (current && s.id === current.id) li.className = 'active';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = s.title;
    if (!s.page) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'unfinished';
      t.append(b);
    }
    const m = document.createElement('div');
    m.className = 'm';
    m.textContent = s.page ? `${s.steps} steps · ${s.judgments} judgment calls · ${fmtDate(s.createdAt)}` : fmtDate(s.createdAt);
    li.append(t, m);
    li.addEventListener('click', () => select(s.id));
    list.append(li);
  }
}

function select(id) {
  current = skills.find((s) => s.id === id) || null;
  $('empty').classList.toggle('hidden', skills.length > 0);
  $('viewer').classList.toggle('hidden', !current);
  renderList();
  if (!current) return;
  $('title').textContent = current.title;
  const bits = [fmtDate(current.createdAt)];
  if (current.page) bits.push(`${current.steps} steps`, `${current.judgments} judgment calls`, `${current.guardrails} guardrails`);
  if (current.confirmed) bits.push('confirmed by the expert');
  $('meta').textContent = bits.join(' · ');
  $('open').disabled = !current.page;
  $('run').disabled = !current.page;
  $('frame').src = current.page || 'about:blank';
}

async function load(selectId) {
  skills = await window.hub.list();
  const keep = selectId || (current && current.id) || (skills[0] && skills[0].id);
  select(keep);
}

$('search').addEventListener('input', renderList);
$('teach').addEventListener('click', () => window.hub.teach());
$('open').addEventListener('click', () => current && window.hub.openExternal(current.id));
$('run').addEventListener('click', () => current && current.page && window.hub.run(current.id));
$('reveal').addEventListener('click', () => current && window.hub.reveal(current.id));
$('delete').addEventListener('click', async () => {
  if (!current || !confirm(`Delete "${current.title}"? It goes to the Trash.`)) return;
  await window.hub.remove(current.id);
  current = null;
  load();
});
window.hub.onChanged((id) => load(id));
load();
