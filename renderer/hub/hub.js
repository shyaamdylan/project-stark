const $ = (id) => document.getElementById(id);
let skills = [];
let current = null;
let filter = 'all';
const date = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const state = (s) => !s.page ? 'Unfinished' : s.confirmed ? 'Expert confirmed' : 'Needs review';
function visibleSkills() {
  const q = $('search').value.trim().toLowerCase();
  return skills.filter((s) => (filter === 'all' || (filter === 'confirmed' ? s.confirmed && s.page : !s.confirmed || !s.page)) && (!q || `${s.title} ${s.summary}`.toLowerCase().includes(q)))
    .sort((a, b) => $('sort').value === 'name' ? a.title.localeCompare(b.title) : b.createdAt - a.createdAt);
}
function renderList() {
  const visible = visibleSkills();
  $('list').replaceChildren();
  $('no-results').classList.toggle('hidden', !skills.length || visible.length > 0);
  $('library-meta').textContent = `${visible.length} ${visible.length === 1 ? 'procedure' : 'procedures'}`;
  for (const s of visible) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.className = 'skill-row' + (current?.id === s.id ? ' active' : '');
    row.setAttribute('aria-current', current?.id === s.id ? 'true' : 'false');
    const title = document.createElement('div'); title.className = 't'; title.textContent = s.title;
    const summary = document.createElement('div'); summary.className = 'summary'; summary.textContent = s.summary;
    const meta = document.createElement('div'); meta.className = 'm';
    const badge = document.createElement('span'); badge.className = 'badge' + (s.page && s.confirmed ? ' confirmed' : ''); badge.textContent = state(s);
    const steps = document.createElement('span'); steps.textContent = s.page ? `${s.steps} steps` : 'Recording';
    meta.append(badge, steps); row.append(title, summary, meta);
    row.addEventListener('click', () => select(s.id)); li.append(row); $('list').append(li);
  }
}
function select(id) {
  const previous = current?.id;
  current = skills.find((s) => s.id === id) || null;
  $('empty').classList.toggle('hidden', skills.length > 0);
  $('selection-empty').classList.toggle('hidden', !skills.length || Boolean(current));
  $('viewer').classList.toggle('hidden', !current);
  renderList();
  document.querySelector('.more').open = false;
  if (!current) { $('frame').src = 'about:blank'; return; }
  $('title').textContent = current.title;
  $('status').textContent = state(current);
  $('status').className = 'status' + (current.page && current.confirmed ? ' confirmed' : '');
  $('meta').textContent = [current.page ? `${current.steps} steps` : null, current.judgments ? `${current.judgments} decision ${current.judgments === 1 ? 'point' : 'points'}` : null, `Recorded ${date(current.createdAt)}`].filter(Boolean).join(' · ');
  $('learn').disabled = !current.page; $('export').disabled = !current.page; $('open').disabled = !current.page; $('run').disabled = !current.page;
  $('unfinished').classList.toggle('hidden', Boolean(current.page));
  $('frame').classList.toggle('hidden', !current.page);
  if (previous !== current.id || $('frame').getAttribute('src') !== current.page) $('frame').src = current.page || 'about:blank';
}
async function load(selectId) {
  try {
    skills = await window.hub.list();
    $('load-error').classList.add('hidden');
    $('all-count').textContent = skills.length;
    $('confirmed-count').textContent = skills.filter((s) => s.confirmed && s.page).length;
    $('draft-count').textContent = skills.filter((s) => !s.confirmed || !s.page).length;
    const visible = visibleSkills();
    const keep = selectId || (visible.some((s) => s.id === current?.id) ? current.id : visible[0]?.id);
    select(keep);
  } catch { $('load-error').classList.remove('hidden'); $('library-meta').textContent = 'Library unavailable'; }
}
function updateCollection() {
  const visible = visibleSkills();
  select(visible.some((s) => s.id === current?.id) ? current.id : visible[0]?.id);
}
$('search').addEventListener('input', updateCollection);
$('sort').addEventListener('change', updateCollection);
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  $('collection-title').textContent = button.firstElementChild.textContent;
  document.querySelectorAll('[data-filter]').forEach((b) => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  updateCollection();
}));
$('teach').addEventListener('click', () => window.hub.teach());
$('empty-teach').addEventListener('click', () => window.hub.teach());
$('retry').addEventListener('click', () => load());
$('open').addEventListener('click', () => { if (current) window.hub.openExternal(current.id); document.querySelector('.more').open = false; });
$('learn').addEventListener('click', () => current?.page && window.hub.learn(current.id));
$('export').addEventListener('click', async () => {
  if (!current?.page) return;
  try { await window.hub.exportForAgents(current.id); document.querySelector('.more').open = false; }
  catch { alert('This procedure couldn’t be exported. Try again.'); }
});
$('run').addEventListener('click', () => current?.page && window.hub.run(current.id));
$('reveal').addEventListener('click', () => { if (current) window.hub.reveal(current.id); document.querySelector('.more').open = false; });
$('delete').addEventListener('click', async () => {
  if (!current || !confirm(`Move “${current.title}” to the Trash? You can restore its folder from the Mac's Trash.`)) return;
  try { await window.hub.remove(current.id); current = null; await load(); }
  catch { alert('This procedure couldn’t be moved to the Trash. Try again.'); }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); }
  if (e.key === 'Escape') document.querySelector('.more').open = false;
});
document.addEventListener('click', (e) => { if (!e.target.closest('.more')) document.querySelector('.more').open = false; });
window.hub.onChanged((id) => load(id));
load();
