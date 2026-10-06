const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state = null, page = 'home', selectedSkillId = null, editingMap = null, walkthrough = null;
let creatingBusiness = false;
let theme = localStorage.getItem('stark-window-theme') || 'dark';
const b = () => state?.business;
const member = () => state?.membership;
const admin = () => member()?.roles.includes('admin');
const expert = sk => admin() || (member()?.roles.includes('expert') && sk.expertIds.includes(state.user.id));
const lead = sk => admin() || (expert(sk) && sk.leadId === state.user.id);
const userName = id => state?.accounts.find(u => u.id === id)?.name || 'Unknown member';
const skill = () => b()?.skills.find(s => s.id === selectedSkillId);
const status = sk => sk.versions.length ? `Approved · v${sk.versions.at(-1).number}` : sk.draft ? 'Needs review' : 'Not started';
const date = ms => new Date(ms).toLocaleDateString(undefined, {day:'numeric',month:'short'});
function notify(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(notify.timer); notify.timer = setTimeout(() => $('toast').classList.add('hidden'), 4000); }
function appearance() { document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme; $('theme').value = theme; }
function showError(message) { $('app-error').textContent = message; $('app-error').classList.remove('hidden'); $('app-error').focus(); }
async function call(action, input = {}, message = '') {
  const controls = [...document.querySelectorAll('button,select')].filter(el => !el.disabled);
  controls.forEach(el => { el.disabled = true; });
  $('app-error').classList.add('hidden'); $('busy-status').textContent = message || 'Saving your workspace…'; $('busy-status').classList.remove('hidden');
  try {
    if (!window.workspace) throw new Error('Open this workspace in the Friday desktop app.');
    const response = await window.workspace.request(action, input);
    if (response.error) throw new Error(response.error);
    state = response.state; render(); return response.result;
  } catch (error) { showError(error.message); throw error; }
  finally { controls.forEach(el => { if (el.isConnected) el.disabled = false; }); $('busy-status').classList.add('hidden'); }
}
function navigate(next) {
  if (!$(next)?.classList.contains('page')) return;
  if (['plan','team','setup'].includes(next) && b() && !admin() && !(next === 'setup' && creatingBusiness)) next = 'home';
  page = next;
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('hidden', el.id !== page));
  document.querySelectorAll('nav [data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === page); if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('page-label').textContent = {home:'Home',skills:'Skills Hub',setup:'Business setup',account:'Account',settings:'Settings',plan:'Teaching plan',team:'People',training:'Training',procedure:'Procedure',recordings:'Local recordings'}[page];
  $(page).scrollTop = 0;
}
const button = (label, action, attrs = '', className = '') => `<button type="button" data-action="${action}" ${attrs} class="${className}">${label}</button>`;
const heading = (eyebrow, title, subtitle = '') => `<div class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div></div>`;
const badge = (label, ready = false) => `<span class="status-pill ${ready ? 'ready' : ''}">${esc(label)}</span>`;
const empty = (title, copy) => `<div class="workspace-empty"><h2>${esc(title)}</h2><p>${esc(copy)}</p></div>`;
const options = (users, selected) => users.map(u => `<option value="${u.id}" ${selected === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
function render() {
  if (!state) return;
  $('profile-name').textContent = state.user.name;
  $('initial').textContent = state.user.name[0].toUpperCase();
  document.querySelector('.workspace div').firstChild.textContent = b()?.name || 'New business';
  $('name').value = state.user.name;
  $('demo-account').innerHTML = options(state.accounts, state.user.id);
  document.querySelectorAll('[data-admin]').forEach(el => el.classList.toggle('hidden', Boolean(b() && !admin())));
  renderDashboard(); renderOnboarding(); renderPlan(); renderTeam(); renderLibrary(); renderTraining(); renderAccount();
  if (selectedSkillId && skill()) renderProcedure();
  navigate(page); icons();
}
function renderDashboard() {
  const root = $('workspace-dashboard');
  if (!b()) { root.innerHTML = `<div class="dashboard-welcome"><div><h2>Bring Friday into your business.</h2><p>Start with your website, agree what matters, then invite your experts.</p></div>${button('Onboard your business →','goSetup','','primary')}${button('Explore a sample business','loadDemo')}</div>`; return; }
  const mine = b().skills.filter(s => expert(s));
  const approved = b().skills.filter(s => s.versions.length).length;
  const pending = mine.reduce((n,s) => n + (s.contributions || []).filter(c => c.status === 'pending').length, 0);
  let title, copy, cards;
  if (admin()) {
    title = `${b().name}, meet Friday.`;
    copy = b().onboardingComplete ? 'Your teaching plan is ready. Bring your experts in and build the knowledge together.' : 'Let’s understand your business and agree what Friday should learn first.';
    cards = `<div><strong>${b().skills.length}</strong><span>Procedures in your plan</span></div><div><strong>${approved}</strong><span>Approved for training</span></div><div><strong>${b().members.length}</strong><span>Workspace members</span></div>`;
  } else if (member()?.roles.includes('expert')) {
    title = `Friday needs your expertise, ${state.user.name.split(' ')[0]}.`;
    copy = 'Teach your assigned procedures, add the details, and review what your team has learned.';
    cards = `<div><strong>${mine.length}</strong><span>Assigned procedures</span></div><div><strong>${pending}</strong><span>Contributions to review</span></div><div><strong>${mine.filter(s=>s.versions.length).length}</strong><span>Approved procedures</span></div>`;
  } else {
    title = `Your next chapter, ${state.user.name.split(' ')[0]}.`;
    copy = 'Learn the procedures assigned to you, with Friday by your side.';
    cards = `<div><strong>${b().paths.filter(p=>p.learnerIds.includes(state.user.id)).length}</strong><span>Your learning paths</span></div><div><strong>${b().attempts.filter(a=>a.userId===state.user.id && a.status !== 'in_progress').length}</strong><span>Walkthroughs completed</span></div><div><strong>${b().attempts.filter(a=>a.userId===state.user.id && a.status === 'signed_off').length}</strong><span>Signed off</span></div>`;
  }
  root.innerHTML = `<div class="dashboard-heading"><div class="eyebrow">${esc(member().roles.join(' / '))}</div><h2>${esc(title)}</h2><p>${esc(copy)}</p><div class="inline-actions">${admin() ? button(b().onboardingComplete ? 'Open teaching plan' : 'Continue onboarding','goSetup','','primary') : button(member().roles.includes('expert') ? 'Your assigned procedures' : 'Continue training',member().roles.includes('expert') ? 'goSkills' : 'goTraining','','primary')}</div></div><div class="workspace-stats">${cards}</div>`;
  // Learners get a direct route to training; experts retain Friday's teaching hero.
  $('record').disabled = !member().roles.some(r=>['expert','admin'].includes(r));
  $('home-record').disabled = $('record').disabled;
}
function renderOnboarding() {
  const root = $('onboarding-root');
  if (!creatingBusiness && b() && !admin()) { root.innerHTML = empty('Your workspace is ready','Your business admin manages company onboarding.'); return; }
  if (creatingBusiness || !b()) {
    root.innerHTML = heading('BUSINESS ONBOARDING','Let’s bring Friday up to speed.','She’ll do her homework, ask the right questions, and help you build a teaching plan.') + `<div class="onboarding-layout"><article class="panel"><form data-form="createBusiness"><label for="company-name">Company name</label><input id="company-name" name="name" required maxlength="100" placeholder="Your business"><label for="owner-name">Your name</label><input id="owner-name" name="ownerName" required maxlength="100" value="${esc(state.user.name === 'Workspace owner' ? '' : state.user.name)}"><label for="company-site">Company website <span class="muted">(optional)</span></label><input id="company-site" name="website" placeholder="https://your-company.com"><button class="primary">Create workspace →</button></form></article><article class="onboarding-aside"><div class="mini-orb"></div><h2>First, a little groundwork.</h2><p>Friday reads your public website, then checks her understanding with you. Your experts teach her how the work actually gets done.</p>${button('Try the sample business','loadDemo')}${b() ? button('Back to current business','cancelNewBusiness') : ''}</article></div>`; return;
  }
  let stage = !b().brief ? 0 : !b().brief.confirmed ? 1 : !b().nextQuestion?.complete && !b().planConfirmed ? 2 : 3;
  root.innerHTML = heading('BUSINESS ONBOARDING', b().name, 'Website → company brief → tailored interview → teaching plan') + `<ol class="onboarding-progress">${['Groundwork','Company brief','Interview','Teaching plan'].map((label,i)=>`<li class="${stage===i?'current':stage>i?'complete':''}"><span>${i+1}</span>${label}</li>`).join('')}</ol><div id="onboarding-step"></div>`;
  const step = $('onboarding-step');
  if (stage === 0) step.innerHTML = `<article class="panel wide"><h2>Where should Friday begin?</h2><p>Read your public website, or describe the business if you don’t have one.</p><form data-form="ingest"><label for="website">Company website</label><input id="website" name="website" value="${esc(b().website)}" placeholder="https://your-company.com"><label for="description">What does your company do?</label><textarea id="description" name="description" rows="4" placeholder="Your services, customers, and the team you’d like Friday to help"></textarea><p class="form-help">${state.aiAvailable ? 'Friday will summarise the pages she can read. You confirm the result before continuing.' : 'No AI key is configured. Friday can collect readable website text; you’ll write the brief and build the plan manually.'}</p><button class="primary">${state.aiAvailable ? 'Let Friday do her homework' : 'Gather company information'} →</button></form></article>`;
  else if (stage === 1) step.innerHTML = `<article class="panel wide"><h2>Here’s what Friday understands.</h2>${badge(b().brief.mode === 'ai' ? 'AI draft · confirm before continuing' : 'Manual brief · edit before continuing')}<form data-form="saveBrief"><label for="brief-summary">Company brief</label><textarea id="brief-summary" name="summary" rows="6" required>${esc(b().brief.summary)}</textarea>${b().brief.observations?.length ? `<div class="brief-evidence"><h3>From the website</h3><ul>${b().brief.observations.map(o=>`<li>${esc(o)}</li>`).join('')}</ul></div>` : ''}${b().brief.suggestions?.length ? `<div class="brief-evidence"><h3>Questions to confirm</h3><ul>${b().brief.suggestions.map(o=>`<li>${esc(o)}</li>`).join('')}</ul></div>` : ''}<div class="source-list">${b().brief.sources.map(url=>`<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>`).join('')}</div><label for="training-goal">What would you like Friday to help people learn?</label><textarea id="training-goal" name="goal" rows="2" required placeholder="Start with one role or workflow">${esc(b().goal)}</textarea><button class="primary">Confirm & meet Friday →</button></form></article>`;
  else if (stage === 2) {
    const q = b().nextQuestion;
    step.innerHTML = `<div class="interview-layout"><article class="panel"><span class="agent-status"><span class="dot"></span> FRIDAY / ${q?.mode === 'ai' ? 'TAILORED INTERVIEW' : 'GUIDED INTERVIEW'}</span>${q?.question ? `<h2 class="interview-question">${esc(q.question)}</h2><p>${esc(q.reason)}</p><form data-form="answer"><label for="interview-answer">Your answer</label><textarea id="interview-answer" name="answer" rows="5" required placeholder="Tell Friday how it works in your business"></textarea><div class="inline-actions"><button class="primary">Continue →</button>${button('Skip this question','skipQuestion')}</div></form>` : `<p>${state.aiAvailable ? 'Friday will tailor her questions to your brief and answers.' : 'This guided interview covers your role, tasks, tools, experts, and readiness criteria. Add an AI key for adaptive follow-ups.'}</p>${button('Start interview','question','','primary')}`}<div class="interview-footer">${b().interview.length ? button('Build the plan from what we have','generatePlan') : ''}</div></article><aside class="interview-notes"><h2>What we’ve learned</h2><p class="muted">Your answers become the groundwork for the plan.</p>${b().interview.map(a=>`<details><summary>${esc(a.question)}</summary><form data-form="updateAnswer" data-id="${a.id}"><label for="answer-${a.id}">Answer</label><textarea id="answer-${a.id}" name="answer" rows="3">${esc(a.answer)}</textarea><button>Save correction</button></form></details>`).join('') || '<p>No answers yet.</p>'}</aside></div>`;
  } else step.innerHTML = `<article class="panel wide"><h2>Your groundwork is ready.</h2><p>${esc(b().goal)}</p><details><summary>Review the company brief and interview answers</summary><p>${esc(b().brief.summary)}</p>${b().interview.map(a=>`<form data-form="updateAnswer" data-id="${a.id}"><label for="final-${a.id}">${esc(a.question)}</label><textarea id="final-${a.id}" name="answer" rows="2">${esc(a.answer)}</textarea><button>Save correction</button></form>`).join('')}</details><div class="inline-actions">${button('Open teaching plan','goPlan','','primary')}${button(state.aiAvailable ? 'Ask Friday to suggest procedures' : 'Start a manual checklist','generatePlan')}</div></article>`;
}
function renderPlan() {
  const root = $('plan-root');
  if (!b()) { root.innerHTML = empty('Start with your business','Complete the company setup to create a teaching plan.') + button('Set up business','goSetup','','primary'); return; }
  if (!admin()) { root.innerHTML = empty('Your assigned procedures are in Skills Hub','An admin manages the teaching plan.'); return; }
  root.innerHTML = heading('TEACHING PLAN','What should Friday learn?','Add, refine, assign, and prioritise the procedures your team needs.') + `<div class="inline-actions">${badge(b().planConfirmed ? 'Plan confirmed' : 'Draft plan', b().planConfirmed)}${button('Confirm teaching plan','confirmPlan','','primary')}${b().brief?.confirmed && b().interview.length ? button('Suggest missing procedures','generatePlan') : ''}</div>${b().planNote ? `<p class="form-help">${esc(b().planNote)}</p>` : ''}<div class="plan-list">${b().skills.map((sk,i)=>`<article class="plan-item"><div class="plan-number">${i+1}</div><div class="plan-body"><div class="plan-title"><h2>${esc(sk.title)}</h2>${badge(status(sk),sk.versions.length>0)}</div><p>${esc(sk.outcome || 'Add the outcome a learner should achieve.')}</p><div class="item-meta">${esc(sk.priority)} · ${sk.expertIds.length} experts · Lead: ${esc(userName(sk.leadId))}</div><div class="inline-actions">${button('Assign & edit','editPlan',`data-id="${sk.id}"`)}${button('Open procedure','openSkill',`data-id="${sk.id}"`)}${button('↑','moveSkill',`data-id="${sk.id}" data-direction="up" aria-label="Move ${esc(sk.title)} up"`)}${button('↓','moveSkill',`data-id="${sk.id}" data-direction="down" aria-label="Move ${esc(sk.title)} down"`)}${button('Remove','archiveSkill',`data-id="${sk.id}"`,'danger')}</div><div id="edit-${sk.id}" class="hidden"></div></div></article>`).join('') || empty('Start with one procedure','Add a task from your interview, or ask Friday to propose a checklist.')}</div><article class="panel wide"><h2>Add a procedure</h2><form data-form="addSkill"><label for="new-skill-title">Procedure name</label><input id="new-skill-title" name="title" required maxlength="160" placeholder="A specific task someone should learn"><label for="new-skill-outcome">Learning outcome</label><textarea id="new-skill-outcome" name="outcome" rows="2" placeholder="What should they be able to do independently?"></textarea><label for="new-priority">Priority</label><select id="new-priority" name="priority"><option value="essential">Essential</option><option value="useful">Useful</option><option value="later">Later</option></select><button class="primary">Add to teaching plan</button></form></article>`;
}
function editPlan(id) {
  const sk = b().skills.find(s=>s.id===id), root = $('edit-'+id); const users = state.accounts.filter(u=>u.roles.some(r=>r==='expert'||r==='admin'));
  root.classList.remove('hidden'); root.innerHTML = `<form data-form="updateSkill" data-id="${sk.id}" data-revision="${sk.revision}" class="inline-editor"><label for="title-${id}">Procedure name</label><input id="title-${id}" name="title" value="${esc(sk.title)}" required><label for="outcome-${id}">Outcome</label><textarea id="outcome-${id}" name="outcome" rows="2">${esc(sk.outcome)}</textarea><label for="priority-${id}">Priority</label><select id="priority-${id}" name="priority">${['essential','useful','later'].map(v=>`<option ${v===sk.priority?'selected':''}>${v}</option>`).join('')}</select><fieldset><legend>Experts who can teach this procedure</legend>${users.map(u=>`<label class="check"><input type="checkbox" name="expertIds" value="${u.id}" ${sk.expertIds.includes(u.id)?'checked':''}>${esc(u.name)}</label>`).join('')}</fieldset><label for="lead-${id}">Lead reviewer</label><select id="lead-${id}" name="leadId">${options(users,sk.leadId)}</select><button class="primary">Save assignments</button></form>`;
}
function renderTeam() {
  const root = $('team-root');
  if (!b() || !admin()) { root.innerHTML = empty('People','An admin can invite and manage business members.'); return; }
  root.innerHTML = heading('YOUR BUSINESS','The people behind the knowledge.','Invite experts to teach Friday and learners to build confidence.') + `<div class="team-grid">${b().members.map(m=>`<article class="member-card"><span class="avatar">${esc(userName(m.userId)[0])}</span><h2>${esc(userName(m.userId))}</h2><p>${esc(state.accounts.find(u=>u.id===m.userId)?.email)}</p><form data-form="updateMember" data-id="${m.userId}"><fieldset><legend>Workspace roles</legend>${['admin','expert','learner'].map(r=>`<label class="check"><input type="checkbox" name="roles" value="${r}" ${m.roles.includes(r)?'checked':''}>${r}</label>`).join('')}</fieldset><button>Save roles</button></form></article>`).join('')}</div><article class="panel wide"><h2>Invite someone</h2><form data-form="invite"><label for="invite-name">Name</label><input id="invite-name" name="name" maxlength="100"><label for="invite-email">Email</label><input id="invite-email" name="email" type="email" required><fieldset><legend>They’ll join as</legend><label class="check"><input type="checkbox" name="roles" value="expert" checked>Expert</label><label class="check"><input type="checkbox" name="roles" value="learner">Learner</label><label class="check"><input type="checkbox" name="roles" value="admin">Admin</label></fieldset><button class="primary">Create demo invitation</button><p class="form-help">No email is sent. Use “Accept as invitee” below to simulate joining.</p></form></article><h2 class="section-title">Invitations</h2><div class="invitation-list">${state.invites.map(i=>`<article class="invitation"><div><strong>${esc(i.email)}</strong><p>${esc(i.roles.join(' + '))} · ${esc(i.status)} · expires ${date(i.expiresAt)}</p></div>${i.status==='pending' ? `<div class="inline-actions">${button('Accept as invitee','acceptInvite',`data-id="${i.id}"`)}${button('Revoke','revokeInvite',`data-id="${i.id}"`)}</div>` : ''}</article>`).join('') || '<p class="muted">No invitations yet.</p>'}</div>`;
}
function renderLibrary() {
  const root = $('skill-library'); const query = $('skill-search').value.trim().toLowerCase();
  if (!b()) { root.innerHTML = empty('Your business knowledge starts here','Set up your business and create its teaching plan.'); return; }
  const list = b().skills.filter(s=>`${s.title} ${s.outcome}`.toLowerCase().includes(query));
  root.innerHTML = `<div class="skill-grid">${list.map(sk=>`<button class="library-skill" data-action="openSkill" data-id="${sk.id}">${badge(status(sk),sk.versions.length>0)}<h2>${esc(sk.title)}</h2><p>${esc(sk.outcome)}</p><span class="item-meta">${sk.learnerView ? 'Approved training' : `${sk.expertIds.length} experts · ${(sk.contributions||[]).filter(c=>c.status==='pending').length} contributions to review`}</span><span class="card-link">${sk.learnerView ? 'View training guide' : 'Open procedure'} →</span></button>`).join('')}</div>${list.length ? '' : empty('No procedures to show',member()?.roles.includes('learner') ? 'Your admin will assign approved procedures through a learning path.' : 'Add a procedure in your teaching plan, or ask your admin to assign one.')}`;
}
function renderAccount() {
  $('account-root').innerHTML = b() ? `<article class="panel"><h2>Business membership</h2><p>${esc(b().name)} · ${esc(member().roles.join(' + '))}</p><label for="business-switch">Business workspace</label><select id="business-switch">${state.businesses.map(w=>`<option value="${w.id}" ${w.id===b().id?'selected':''}>${esc(w.name)}</option>`).join('')}</select><div class="inline-actions">${button('Create another business','newBusiness','','primary')}</div>${admin() ? `<form data-form="businessProfile"><label for="business-profile-name">Business name</label><input id="business-profile-name" name="name" required value="${esc(b().name)}"><button>Save business name</button></form>` : ''}</article>` : '';
}
function renderTraining() {
  const root = $('training-root');
  if (!b()) { root.innerHTML = empty('Training starts with approved knowledge','Create your business and teach Friday a procedure first.'); return; }
  const isLearner = member().roles.includes('learner');
  const myPaths = b().paths.filter(p=>p.learnerIds.includes(state.user.id));
  root.innerHTML = heading('LEARNING & PROGRESS',isLearner ? 'Build confidence with Friday.' : 'Turn knowledge into a learning path.',isLearner ? 'Your assigned procedures, one step at a time.' : 'Assign approved procedures and see how learners are progressing.');
  if (isLearner) root.innerHTML += myPaths.map(p=>`<article class="learning-path"><div class="plan-title"><h2>${esc(p.title)}</h2>${badge(p.signoff?'Expert sign-off required':'Guided completion')}</div><p class="muted">${esc(p.role)}</p>${p.skillIds.map(sid=>{ const sk=b().skills.find(s=>s.id===sid); if(!sk)return ''; const attempts=b().attempts.filter(a=>a.userId===state.user.id&&a.skillId===sid); const latest=attempts.at(-1); return `<div class="path-procedure"><div><strong>${esc(sk.title)}</strong><p>${latest ? `${esc(latest.status.replaceAll('_',' '))} · version ${latest.version}` : 'Not started'}</p></div><div class="inline-actions">${button('View guide','openSkill',`data-id="${sid}"`)}${button(latest?.status==='in_progress'?'Resume demo':'Demo walkthrough','walkthrough',`data-id="${sid}"`,'primary')}${button('Train on desktop','desktopTraining',`data-id="${sid}"`)}</div></div>`; }).join('')}</article>`).join('') || empty('Your training will appear here','Ask your admin to assign a learning path.');
  if (walkthrough && walkthrough.userId === state.user.id) root.innerHTML += walkthroughHTML();
  if (admin()) {
    const approved = b().skills.filter(s=>s.versions.length), learners=state.accounts.filter(u=>u.roles.includes('learner'));
    root.innerHTML += `<article class="panel wide"><h2>Create a learning path</h2>${approved.length ? `<form data-form="createPath"><label for="path-title">Path name</label><input id="path-title" name="title" required placeholder="New accounts assistant"><label for="path-role">Role or team</label><input id="path-role" name="role"><fieldset><legend>Approved procedures</legend>${approved.map(sk=>`<label class="check"><input type="checkbox" name="skillIds" value="${sk.id}">${esc(sk.title)} · v${sk.versions.at(-1).number}</label>`).join('')}</fieldset><fieldset><legend>Assign to learners</legend>${learners.map(u=>`<label class="check"><input type="checkbox" name="learnerIds" value="${u.id}">${esc(u.name)}</label>`).join('') || '<p>Invite a learner in People first.</p>'}</fieldset><label class="check"><input type="checkbox" name="signoff" checked>Require expert sign-off after training</label><button class="primary">Create & assign path</button></form>` : '<p>Approve a procedure before creating a learning path.</p>'}</article><h2 class="section-title">Learning paths</h2>${b().paths.map(p=>`<article class="panel wide"><div class="plan-title"><h2>${esc(p.title)}</h2>${badge(p.signoff?'Sign-off required':'Guided completion')}</div><p>${p.skillIds.map(sid=>esc(b().skills.find(s=>s.id===sid)?.title)).join(' · ')}</p><p class="muted">Assigned to: ${p.learnerIds.map(uid=>esc(userName(uid))).join(', ') || 'No learners yet'}</p>${button('Edit assignments','editPath',`data-id="${p.id}"`)}<div id="path-edit-${p.id}"></div></article>`).join('')}`;
  }
  if (admin() || member().roles.includes('expert')) root.innerHTML += `<h2 class="section-title">Learner progress</h2>${b().attempts.map(a=>{const sk=b().skills.find(s=>s.id===a.skillId);return `<article class="progress-row"><div><strong>${esc(userName(a.userId))} · ${esc(sk?.title || 'Archived procedure')}</strong><p>Version ${a.version} · ${esc(a.status.replaceAll('_',' '))} · ${date(a.startedAt)}</p>${a.signoffNote?`<p>Sign-off: ${esc(a.signoffNote)}</p>`:''}</div>${sk && lead(sk) && ['awaiting_signoff','completed_with_guidance'].includes(a.status) ? `<form data-form="signoff" data-id="${a.id}"><label for="signoff-${a.id}">Reviewer note</label><input id="signoff-${a.id}" name="note" required placeholder="Why they’re ready"><button class="primary">Sign off</button></form>`:''}</article>`;}).join('') || '<p class="muted">Learner attempts will appear once training starts.</p>'}`;
}
function editPath(id) {
  const p=b().paths.find(p=>p.id===id), users=state.accounts.filter(u=>u.roles.includes('learner'));
  $('path-edit-'+id).innerHTML=`<form data-form="updatePath" data-id="${id}"><label for="path-title-${id}">Path name</label><input id="path-title-${id}" name="title" value="${esc(p.title)}" required><label for="path-role-${id}">Role</label><input id="path-role-${id}" name="role" value="${esc(p.role)}"><fieldset><legend>Approved procedures</legend>${b().skills.filter(s=>s.versions.length).map(s=>`<label class="check"><input name="skillIds" type="checkbox" value="${s.id}" ${p.skillIds.includes(s.id)?'checked':''}>${esc(s.title)}</label>`).join('')}</fieldset><fieldset><legend>Learners</legend>${users.map(u=>`<label class="check"><input type="checkbox" name="learnerIds" value="${u.id}" ${p.learnerIds.includes(u.id)?'checked':''}>${esc(u.name)}</label>`).join('')}</fieldset><label class="check"><input type="checkbox" name="signoff" ${p.signoff?'checked':''}>Require sign-off for new attempts</label><button class="primary">Save path</button></form>`;
}
function walkthroughHTML() {
  const map = walkthrough.version.map, step = map.steps[walkthrough.index];
  return `<article class="walkthrough panel wide"><span class="agent-status"><span class="dot"></span> FRIDAY / DEMO WALKTHROUGH · VERSION ${walkthrough.version.number}</span><h2>${esc(map.title)}</h2><p class="form-help">This walkthrough demonstrates the learning flow. It does not observe your desktop or assess your actions.</p><div class="lesson-progress">Step ${walkthrough.index+1} of ${map.steps.length}</div><h3>${esc(step.title)}</h3><p>${esc(step.action)}</p>${step.decision?`<div class="guardrail"><strong>Decision</strong><p>${esc(step.decision)}</p>${step.reason?`<p>Why: ${esc(step.reason)}</p>`:''}</div>`:''}${(step.guardrails||[]).map(g=>`<div class="guardrail"><strong>${esc(g.kind.replaceAll('_',' '))}</strong><p>${esc(g.text)}</p></div>`).join('')}<div class="inline-actions">${walkthrough.index>0?button('Previous','previousLesson'):''}${button(walkthrough.index===map.steps.length-1?'Finish demo walkthrough':'I’ve done this step →','nextLesson','','primary')}${button('Pause','pauseLesson')}</div></article>`;
}
function guideHTML(map) {
  if (!map) return empty('A guide is waiting to be taught','An expert can record the procedure or create its first draft.');
  return `<div class="guide-content"><h2>${esc(map.title)}</h2><p>${esc(map.summary)}</p>${map.prerequisites?.length?`<h3>Before you start</h3><ul>${map.prerequisites.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:''}<ol>${map.steps.map(st=>`<li><h3>${esc(st.title)}</h3><p>${esc(st.action)}</p>${st.decision?`<div class="guardrail"><strong>Decision</strong><p>${esc(st.decision)}</p>${st.reason?`<p>Why: ${esc(st.reason)}</p>`:''}${st.rule?`<p>Rule: ${esc(st.rule)}</p>`:''}</div>`:''}${st.guardrails.map(g=>`<div class="guardrail"><strong>${esc(g.kind.replaceAll('_',' '))}</strong><p>${esc(g.text)}</p></div>`).join('')}</li>`).join('')}</ol>${map.open_questions?.length?`<div class="guardrail"><h3>Open questions</h3><ul>${map.open_questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul></div>`:''}</div>`;
}
function renderProcedure() {
  const sk = skill(); if (!sk) return;
  const isExpert = expert(sk) && !sk.learnerView, canLead = lead(sk) && !sk.learnerView, latest=sk.versions.at(-1);
  const root = $('procedure-root');
  root.innerHTML = `${button('← Skills Hub','goSkills')}${heading('PROCEDURE',sk.title,sk.outcome)}<div class="inline-actions">${badge(status(sk),!!latest)}<span class="muted">Lead reviewer: ${esc(userName(sk.leadId))}</span>${isExpert ? button('Record with Friday','recordSkill',`data-id="${sk.id}"`,'primary') : ''}${canLead?button('Edit draft','editDraft'):''}${canLead?button('Approve new version','approve',`data-id="${sk.id}" data-revision="${sk.revision}"`):''}</div><div class="procedure-columns"><div><article class="panel wide"><div class="plan-title"><h2>${isExpert ? 'Working draft' : 'Approved guide'}</h2>${isExpert && latest?badge(`Learners use v${latest.number}`,true):''}</div><div id="guide-view">${guideHTML(isExpert?sk.draft:latest?.map)}</div><div id="guide-editor" class="${editingMap?'':'hidden'}"></div></article>${latest?`<article class="panel wide"><h2>Approved versions</h2><label for="version-picker">Read an approved snapshot</label><select id="version-picker">${[...sk.versions].reverse().map(v=>`<option value="${v.number}">Version ${v.number} · approved by ${esc(userName(v.approvedBy))} · ${date(v.approvedAt)}</option>`).join('')}</select><details id="approved-preview"><summary>Read approved guide</summary><div id="approved-guide">${guideHTML(latest.map)}</div></details></article>`:''}</div><div>${isExpert?`<article class="panel wide"><h2>Expert contributions</h2><p class="form-help">Add detail or demonstrate another case. Friday proposes changes; the lead reviewer decides what becomes training.</p>${(sk.contributions||[]).map(c=>`<article class="contribution"><div class="plan-title"><strong>${esc(userName(c.userId))}</strong>${badge(c.status)}</div><p>${esc(c.note || c.map?.summary || 'Recorded demonstration')}</p>${c.kind==='recording'?`<details><summary>Compare this recording</summary>${guideHTML(c.map)}</details>`:''}${c.proposal?`<div class="guardrail"><strong>Friday’s proposal</strong><p>${esc(c.proposal)}</p></div>`:''}${state.aiAvailable?button('Ask Friday to compare','refine',`data-id="${c.id}"`):''}${canLead&&c.map?button('Use recording as draft','useRecording',`data-id="${c.id}"`):''}${canLead&&c.status==='pending'?`<form data-form="reviewContribution" data-id="${c.id}" data-revision="${sk.revision}"><label for="review-${c.id}">Review outcome</label><select id="review-${c.id}" name="status"><option value="incorporated">Incorporated into draft</option><option value="alternative">Documented as an alternative</option><option value="rejected">Not included</option></select><label for="decision-${c.id}">Explain your decision</label><textarea id="decision-${c.id}" name="decision" required rows="2" placeholder="Explain what you changed or why it is not included"></textarea><button>Save review</button></form>`:''}${c.review?`<p class="review-note">${esc(userName(c.review.userId))}: ${esc(c.review.decision)}</p>`:''}</article>`).join('') || '<p>No contributions yet.</p>'}<form data-form="contribute"><label for="contribution-note">Your detail, exception, or correction</label><textarea id="contribution-note" name="note" required rows="3"></textarea><button class="primary">Add contribution</button></form>${button('Import a local recording','importRecording')}</article><article class="panel wide"><h2>Questions & disagreements</h2>${(sk.questions||[]).map(q=>`<article class="question-card"><p>${esc(q.text)}</p>${q.resolution?`<p class="review-note">Resolved by ${esc(userName(q.resolution.userId))}: ${esc(q.resolution.text)}</p>`:canLead?`<form data-form="resolveQuestion" data-id="${q.id}" data-revision="${sk.revision}"><label for="resolve-${q.id}">Agreed resolution</label><textarea id="resolve-${q.id}" name="resolution" required rows="2" placeholder="Explain the rule and any valid variations"></textarea><button>Resolve question</button></form>`:badge('Needs lead review')}</article>`).join('') || '<p class="muted">No unresolved disagreements.</p>'}<form data-form="addQuestion" data-revision="${sk.revision}"><label for="new-question">Something still unclear?</label><textarea id="new-question" name="text" rows="2" required></textarea><button>Add question</button></form></article>`: `<article class="notice"><h3>Approved for your training</h3><p>Draft changes and expert discussions stay with the reviewers. Your lessons use an approved version.</p>${button('Your learning paths','goTraining','','primary')}</article>`}</div></div>`;
  if (editingMap) paintEditor();
}
function blankStep() { return {title:'',action:'',event_ids:[],is_judgment:false,decision:null,reason:null,rule:null,guardrails:[]}; }
function readEditor() {
  const form=$('draft-form'); if(!form) return;
  editingMap.title=form.elements.title.value; editingMap.summary=form.elements.summary.value;
  editingMap.prerequisites=form.elements.prerequisites.value.split('\n').map(s=>s.trim()).filter(Boolean);
  editingMap.open_questions=form.elements.openQuestions.value.split('\n').map(s=>s.trim()).filter(Boolean);
  editingMap.steps=editingMap.steps.map((st,i)=>({...st,title:form.elements['step-title-'+i].value,action:form.elements['step-action-'+i].value,is_judgment:form.elements['step-decision-'+i].value.trim().length>0,decision:form.elements['step-decision-'+i].value.trim()||null,reason:form.elements['step-reason-'+i].value.trim()||null,rule:form.elements['step-rule-'+i].value.trim()||null,guardrails:form.elements['step-guardrails-'+i].value.split('\n').map(s=>s.trim()).filter(Boolean).map((line,j)=>({kind:st.guardrails?.[j]?.kind||'stop_and_ask',text:line,qa_id:st.guardrails?.[j]?.qa_id||null}))}));
}
function paintEditor() {
  $('guide-view').classList.add('hidden'); $('guide-editor').classList.remove('hidden');
  $('guide-editor').innerHTML=`<form id="draft-form" data-form="saveDraft" data-revision="${skill().revision}"><label for="draft-title">Guide title</label><input id="draft-title" name="title" value="${esc(editingMap.title)}" required><label for="draft-summary">Summary</label><textarea id="draft-summary" name="summary" rows="3">${esc(editingMap.summary)}</textarea><label for="draft-prerequisites">Before you start (one item per line)</label><textarea id="draft-prerequisites" name="prerequisites" rows="2">${esc((editingMap.prerequisites||[]).join('\n'))}</textarea><div class="draft-steps">${editingMap.steps.map((st,i)=>`<fieldset><legend>Step ${i+1}</legend><label for="st-title-${i}">Step name</label><input id="st-title-${i}" name="step-title-${i}" value="${esc(st.title)}" required><label for="st-action-${i}">What to do</label><textarea id="st-action-${i}" name="step-action-${i}" rows="2" required>${esc(st.action)}</textarea><label for="st-decision-${i}">Decision or exception</label><textarea id="st-decision-${i}" name="step-decision-${i}" rows="2">${esc(st.decision)}</textarea><label for="st-reason-${i}">Why this matters</label><input id="st-reason-${i}" name="step-reason-${i}" value="${esc(st.reason)}"><label for="st-rule-${i}">Rule to check</label><input id="st-rule-${i}" name="step-rule-${i}" value="${esc(st.rule)}"><label for="st-guardrails-${i}">Guardrails (one per line)</label><textarea id="st-guardrails-${i}" name="step-guardrails-${i}" rows="2">${esc(st.guardrails.map(g=>g.text).join('\n'))}</textarea>${button('Remove step','removeStep',`data-index="${i}"`,'danger')}</fieldset>`).join('')}</div>${button('Add a step','addStep')}<label for="draft-open-questions">Open questions (remove only once resolved)</label><textarea id="draft-open-questions" name="openQuestions" rows="2">${esc((editingMap.open_questions||[]).join('\n'))}</textarea><div class="inline-actions"><button class="primary">Save working draft</button>${button('Cancel editing','cancelEditor')}</div></form>`;
}
const iconPaths = { home:'<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',library:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 4v16M12 9h5M12 13h5"/>',record:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',learn:'<path d="m2 9 10-5 10 5-10 5Z"/><path d="M6 11v6q6 5 12 0v-6M22 9v7"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',account:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>' };
function icons() { document.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+iconPaths[el.dataset.icon]+'</svg>';el.setAttribute('aria-hidden','true');}); }
async function action(el) {
  const a=el.dataset.action, id=el.dataset.id;
  if (a==='newBusiness') { creatingBusiness=true; renderOnboarding(); navigate('setup'); return; }
  if (a==='cancelNewBusiness') { creatingBusiness=false; renderOnboarding(); navigate('account'); return; }
  if (a==='goSetup') { navigate(b()?.onboardingComplete?'plan':'setup'); return; }
  if (a==='goPlan') { navigate('plan'); return; }
  if (a==='goSkills') { navigate('skills'); return; }
  if (a==='goTraining') { navigate('training'); return; }
  if (a==='loadDemo') { creatingBusiness=false; walkthrough=null; selectedSkillId=null; editingMap=null; await call('loadDemo',{},'Preparing a fictional business…'); navigate('plan'); return; }
  if (a==='editPlan') { editPlan(id); return; }
  if (a==='editPath') { editPath(id); return; }
  if (a==='openSkill') { selectedSkillId=id; editingMap=null; renderProcedure(); navigate('procedure'); return; }
  if (a==='moveSkill') { const sk=b().skills.find(s=>s.id===id); await call('reorderSkill',{skillId:id,revision:sk.revision,direction:el.dataset.direction}); return; }
  if (a==='archiveSkill') { if(!confirm('Remove this procedure from the teaching plan? Past training records are kept.'))return; const sk=b().skills.find(s=>s.id===id); await call('archiveSkill',{skillId:id,revision:sk.revision}); return; }
  if (a==='question') { await call('question',{},'Friday is preparing your next question…'); return; }
  if (a==='skipQuestion') { await call('answer',{skip:true},'Friday is preparing your next question…'); return; }
  if (a==='generatePlan') { await call('generatePlan',{},state.aiAvailable?'Friday is building your teaching checklist…':'Preparing your manual checklist…'); navigate('plan'); return; }
  if (a==='confirmPlan') { await call('confirmPlan'); notify('Teaching plan confirmed. Invite and assign your experts next.'); navigate('team'); return; }
  if (a==='acceptInvite') { await call('acceptInvite',{inviteId:id}); notify('Demo invitation accepted. Switch to this account in the sidebar.'); return; }
  if (a==='revokeInvite') { await call('revokeInvite',{inviteId:id}); return; }
  if (a==='recordSkill') { await call('recordProcedure',{skillId:id},'Starting Friday’s desktop recording…'); notify('Continue with Friday in the desktop companion.'); return; }
  if (a==='editDraft') { const sk=skill(); editingMap=structuredClone(sk.draft||{title:sk.title,summary:sk.outcome,prerequisites:[],open_questions:[],steps:[blankStep()],teach_back:''}); paintEditor(); return; }
  if (a==='addStep') { readEditor(); editingMap.steps.push(blankStep()); paintEditor(); return; }
  if (a==='removeStep') { readEditor(); editingMap.steps.splice(Number(el.dataset.index),1); paintEditor(); return; }
  if (a==='cancelEditor') { editingMap=null;renderProcedure();return; }
  if (a==='approve') { await call('approve',{skillId:id,revision:Number(el.dataset.revision)});notify('Approved version published. Learners keep their current lesson version.');return; }
  if (a==='refine') { await call('refine',{skillId:selectedSkillId,contributionId:id},'Friday is comparing this contribution with the draft…'); return; }
  if (a==='useRecording') { if(!confirm('Use this recording as the working draft? The approved guide remains unchanged. Review the other experts’ details before approval.'))return; editingMap=null;await call('useRecording',{skillId:selectedSkillId,contributionId:id,revision:skill().revision});return; }
  if (a==='importRecording') {
    const recordings=await window.hub.list(); const container=document.createElement('div');container.className='panel wide';container.id='import-recordings';container.innerHTML='<h2>Choose a local recording</h2><p class="form-help">Import a recording as an expert contribution to this procedure.</p>'+recordings.filter(r=>r.page&&!r.id.startsWith('workspace-')).map(r=>button(esc(r.title),'attachRecording',`data-id="${esc(r.id)}"`)).join('');if(!recordings.some(r=>r.page&&!r.id.startsWith('workspace-')))container.innerHTML+='<p>No completed local recordings yet.</p>';document.querySelector('#procedure-root .procedure-columns').prepend(container);return;
  }
  if (a==='attachRecording') { const recorded=await window.hub.skill(id);if(!recorded)throw new Error('Recording not found.');await call('recording',{skillId:selectedSkillId,map:recorded.map,session:{events:recorded.events,qas:recorded.qas,startedAt:recorded.startedAt},localId:id});notify('Recording added for expert review.');return; }
  if (a==='walkthrough') { const result=await call('startAttempt',{skillId:id});walkthrough={...result,index:0,userId:state.user.id};renderTraining();navigate('training');$('training-root').querySelector('.walkthrough')?.scrollIntoView({block:'start'});return; }
  if (a==='previousLesson') { walkthrough.index=Math.max(0,walkthrough.index-1);renderTraining();return; }
  if (a==='nextLesson') { if(walkthrough.index===walkthrough.version.map.steps.length-1){const attemptId=walkthrough.attempt.id;walkthrough=null;await call('completeAttempt',{attemptId});notify('Demo walkthrough completed. Your progress is saved.');}else{walkthrough.index++;renderTraining();}return; }
  if (a==='pauseLesson') {walkthrough=null;renderTraining();notify('Paused. Resume the pinned version from your learning path.');return;}
  if (a==='desktopTraining') {walkthrough=null;await call('desktopTraining',{skillId:id},'Preparing your approved lesson…');notify('Continue with Friday on your desktop.');return;}
}
document.addEventListener('click', async event=>{
  const el=event.target.closest('button');if(!el||el.disabled)return;
  if(el.dataset.page){navigate(el.dataset.page);return;}
  try{if(el.dataset.action)await action(el);}catch(error){showError(error.message);}
});
document.addEventListener('submit', async event=>{
  const form=event.target;if(!form.dataset.form&&form.id!=='profile-form')return;event.preventDefault();
  const values=Object.fromEntries(new FormData(form));const data=new FormData(form);const a=form.dataset.form||'profile';
  try{
    if(a==='createBusiness'){await call(a,values);creatingBusiness=false;renderOnboarding();navigate('setup');}
    else if(a==='ingest'){values.website=values.website.trim();if(values.website&&!/^https?:\/\//i.test(values.website))values.website='https://'+values.website;await call(a,values,'Friday is reading your company information…');}
    else if(a==='saveBrief'){await call(a,values);await call('question',{},'Friday is preparing your first question…');}
    else if(a==='answer'){await call(a,values,'Friday is considering your answer…');if(b().nextQuestion.complete){notify('Interview complete. Friday can now help build your plan.');}}
    else if(a==='updateAnswer'){await call(a,{answerId:form.dataset.id,answer:values.answer});notify('Answer updated. New plan suggestions will use this correction.');}
    else if(a==='updateSkill'){await call(a,{...values,skillId:form.dataset.id,revision:Number(form.dataset.revision),expertIds:data.getAll('expertIds')});notify('Procedure and assignments saved.');}
    else if(a==='invite'){await call(a,{...values,roles:data.getAll('roles')});notify('Demo invitation created. No email was sent.');}
    else if(a==='updateMember'){await call(a,{userId:form.dataset.id,roles:data.getAll('roles')});}
    else if(a==='createPath'||a==='updatePath'){await call(a,{...values,pathId:form.dataset.id,skillIds:data.getAll('skillIds'),learnerIds:data.getAll('learnerIds'),signoff:data.has('signoff')});notify('Learning path saved.');}
    else if(a==='saveDraft'){readEditor();const draft=structuredClone(editingMap);await call(a,{skillId:selectedSkillId,revision:Number(form.dataset.revision),map:draft});editingMap=null;renderProcedure();notify('Working draft saved. Approved training is unchanged.');}
    else if(a==='contribute'){await call(a,{skillId:selectedSkillId,note:values.note});notify('Contribution added for lead review.');}
    else if(a==='reviewContribution'){await call(a,{...values,skillId:selectedSkillId,contributionId:form.dataset.id,revision:Number(form.dataset.revision)});}
    else if(a==='resolveQuestion'){await call(a,{...values,skillId:selectedSkillId,questionId:form.dataset.id,revision:Number(form.dataset.revision)});}
    else if(a==='addQuestion'){await call(a,{...values,skillId:selectedSkillId,revision:Number(form.dataset.revision)});}
    else if(a==='signoff'){await call(a,{attemptId:form.dataset.id,note:values.note});notify('Learner signed off by the reviewer.');}
    else {await call(a,values);notify('Saved on this Mac.');}
  }catch(error){showError(error.message);}
});
document.addEventListener('change',async event=>{
  try{
    if(event.target.id==='demo-account'){walkthrough=null;selectedSkillId=null;editingMap=null;await call('switchAccount',{userId:event.target.value});navigate(b()? 'home':'setup');notify('Switched demo account.');}
    if(event.target.id==='business-switch'){walkthrough=null;selectedSkillId=null;editingMap=null;await call('switchBusiness',{businessId:event.target.value});navigate('home');}
    if(event.target.id==='version-picker'){const version=skill().versions.find(v=>v.number===Number(event.target.value));$('approved-guide').innerHTML=guideHTML(version.map);$('approved-preview').open=true;}
    if(event.target.id==='theme'){theme=event.target.value;localStorage.setItem('stark-window-theme',theme);appearance();}
  }catch(error){showError(error.message);}
});
$('skill-search').addEventListener('input',renderLibrary);
for(const id of ['record','home-record'])$(id).addEventListener('click',()=>{if(!b())navigate('setup');else {navigate('skills');notify('Choose a procedure, then record with Friday.');}});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',appearance);
window.workspace?.onChanged(async info=>{try{await call('snapshot',{},'Refreshing your workspace…');if(info.skillId){selectedSkillId=info.skillId;editingMap=null;renderProcedure();navigate('procedure');}if(info.trainingComplete){walkthrough=null;renderTraining();navigate('training');notify('Friday’s lesson is complete. Your progress is saved.');}}catch{}});
window.hub?.onChanged(()=>{if(page!=='procedure')navigate('recordings');});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'){event.preventDefault();navigate('skills');$('skill-search').focus();}});
appearance();icons();
(async()=>{try{await call('snapshot',{},'Opening your business workspace…');navigate(new URLSearchParams(location.search).get('view')==='recordings' ? 'recordings' : !b()||(!b().onboardingComplete&&admin())?'setup':'home');}catch{}})();
