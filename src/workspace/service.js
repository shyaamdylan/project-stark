const crypto = require('crypto');
const { Store } = require('./store');
const { Intelligence } = require('./intelligence');
const id = () => crypto.randomUUID();
const text = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const required = (v, label) => { const s = text(v); if (!s) throw new Error(label + ' is required.'); return s; };
const now = () => Date.now();
const roleList = values => { const roles = [...new Set((values || []).filter(r => ['admin', 'expert', 'learner'].includes(r)))]; if (!roles.length) throw new Error('Choose at least one role.'); return roles; };
function mapFrom(input) {
  if (!input || !Array.isArray(input.steps) || input.steps.length > 100) throw new Error('A guide needs a list of up to 100 steps.');
  return {
    title: required(input.title, 'Guide title'), summary: text(input.summary), confirmed: false,
    prerequisites: (input.prerequisites || []).slice(0, 20).map(v => text(v)),
    open_questions: (input.open_questions || []).slice(0, 20).map(v => text(v)),
    teach_back: text(input.teach_back),
    steps: input.steps.map(st => ({ title: required(st.title, 'Step title'), action: required(st.action, 'Step action'), event_ids: (st.event_ids || []).filter(Number.isInteger).slice(0, 100), is_judgment: Boolean(st.is_judgment), decision: text(st.decision) || null, reason: text(st.reason) || null, rule: text(st.rule) || null, reason_qa_id: st.reason_qa_id || null, reason_event_id: st.reason_event_id || null, guardrails: (st.guardrails || []).slice(0, 30).map(g => ({ kind: ['limit', 'exception', 'stop_and_ask'].includes(g.kind) ? g.kind : 'stop_and_ask', text: required(g.text, 'Guardrail'), qa_id: g.qa_id || null })) })),
  };
}
class WorkspaceService {
  constructor(file, { apiKey, intelligence } = {}) {
    this.store = new Store(file);
    this.brain = intelligence || new Intelligence(apiKey);
    if (!this.store.data.users.length) this.store.commit(d => d.users.push({ id: id(), name: 'Workspace owner', email: 'owner@demo.local' }));
    this.userId = this.store.data.activeUserId || this.store.data.users[0].id;
    this.businessId = this.store.data.activeBusinessId || this.store.data.businesses[0]?.id || null;
  }
  business(data = this.store.data) { const b = data.businesses.find(b => b.id === this.businessId); if (!b) throw new Error('Create a business workspace first.'); return b; }
  member(b = this.business()) { const m = b.members.find(m => m.userId === this.userId); if (!m) throw new Error('This account does not belong to this business.'); return m; }
  admin(b = this.business()) { if (!this.member(b).roles.includes('admin')) throw new Error('Only an admin can do this.'); }
  expert(skill, b = this.business()) { const m = this.member(b); if (!m.roles.includes('admin') && !(m.roles.includes('expert') && skill.expertIds.includes(m.userId))) throw new Error('This procedure is not assigned to you as an expert.'); }
  lead(skill, b = this.business()) { this.expert(skill, b); if (skill.leadId !== this.userId && !this.member(b).roles.includes('admin')) throw new Error('Only the lead reviewer can approve or edit this draft.'); }
  skill(skillId, b = this.business()) { const sk = b.skills.find(s => s.id === skillId && !s.archived); if (!sk) throw new Error('Procedure not found.'); return sk; }
  revision(sk, value) { if (value !== sk.revision) throw new Error('This procedure changed. Refresh it before saving.'); }
  assigned(skillId, b = this.business()) { const m = this.member(b); return m.roles.includes('learner') && b.paths.some(p => p.learnerIds.includes(this.userId) && p.skillIds.includes(skillId)); }
  snapshot() {
    const data = this.store.data;
    const user = data.users.find(u => u.id === this.userId);
    const business = data.businesses.find(b => b.id === this.businessId);
    const m = business?.members.find(m => m.userId === this.userId);
    const admin = m?.roles.includes('admin');
    const output = business && m ? structuredClone(business) : null;
    if (output) {
      output.skills = output.skills.filter(s => !s.archived && (admin || (m.roles.includes('expert') && s.expertIds.includes(this.userId)) || this.assigned(s.id, business))).map(s => {
        if (!admin && !(m.roles.includes('expert') && s.expertIds.includes(this.userId))) return { id: s.id, title: s.title, outcome: s.outcome, priority: s.priority, versions: s.versions, revision: s.revision, expertIds: s.expertIds, leadId: s.leadId, learnerView: true };
        return s;
      });
      output.paths = output.paths.filter(p => admin || p.learnerIds.includes(this.userId) || m.roles.includes('expert'));
      output.attempts = output.attempts.filter(a => admin || a.userId === this.userId || business.skills.find(s => s.id === a.skillId)?.leadId === this.userId);
    }
    return { demo: true, aiAvailable: Boolean(this.brain.ai || this.brain.apiKey), user, membership: m || null, business: output, accounts: data.users.map(u => ({ ...u, roles: business?.members.find(m => m.userId === u.id)?.roles || [] })), businesses: data.businesses.filter(b => b.members.some(m => m.userId === this.userId)).map(b => ({ id: b.id, name: b.name })), invites: admin ? data.invites.filter(i => i.businessId === business.id) : [] };
  }
  makeSkill(input, ownerId) {
    return { id: id(), title: required(input.title, 'Procedure title'), outcome: text(input.outcome), priority: ['essential', 'useful', 'later'].includes(input.priority) ? input.priority : 'essential', rationale: text(input.rationale), expertIds: [], leadId: ownerId, revision: 0, draft: null, draftSession: null, contributions: [], questions: [], versions: [], archived: false, createdAt: now() };
  }
  async request(action, input = {}) {
    let result = null;
    if (action === 'snapshot') return { state: this.snapshot() };
    if (action === 'switchAccount') {
      if (!this.store.data.users.some(u => u.id === input.userId)) throw new Error('Account not found.');
      this.userId = input.userId;
      if (!this.store.data.businesses.find(b => b.id === this.businessId)?.members.some(m => m.userId === this.userId)) this.businessId = this.store.data.businesses.find(b => b.members.some(m => m.userId === this.userId))?.id || null;
      this.store.commit(d => { d.activeUserId = this.userId; d.activeBusinessId = this.businessId; });
    } else if (action === 'switchBusiness') {
      const b = this.store.data.businesses.find(b => b.id === input.businessId);
      if (!b?.members.some(m => m.userId === this.userId)) throw new Error('Workspace is not available to this account.');
      this.businessId = b.id; this.store.commit(d => { d.activeBusinessId = b.id; });
    } else if (action === 'loadDemo') {
      const fixture = require('./demo').demoWorkspace(this.userId);
      this.store.commit(d => { d.users.push(...fixture.users); d.businesses.push(fixture.business); d.activeBusinessId = fixture.business.id; });
      this.businessId = fixture.business.id;
    } else if (action === 'createBusiness') {
      const name = required(input.name, 'Company name'); const businessId = id();
      this.store.commit(d => { d.businesses.push({ id: businessId, name, website: text(input.website, 2000), goal: '', brief: null, interview: [], nextQuestion: null, planConfirmed: false, onboardingComplete: false, members: [{ userId: this.userId, roles: ['admin', 'expert'], joinedAt: now() }], skills: [], paths: [], attempts: [] }); d.activeBusinessId = businessId; const u = d.users.find(u => u.id === this.userId); u.name = text(input.ownerName, 100) || u.name; });
      this.businessId = businessId;
    } else {
      const b = this.business(); this.member(b);
      if (['ingest', 'saveBrief', 'answer', 'question', 'generatePlan', 'confirmPlan', 'addSkill', 'updateSkill', 'archiveSkill', 'reorderSkill', 'invite', 'revokeInvite', 'updateMember', 'createPath', 'updatePath', 'updateAnswer', 'businessProfile'].includes(action)) this.admin(b);
      if (action === 'ingest') {
        const website = text(input.website, 2000); const description = text(input.description);
        if (!website && !description) throw new Error('Enter a website or describe your business.');
        result = await this.brain.brief(website, description);
        this.store.commit(d => { const current = this.business(d); current.website = website; current.brief = result; });
      } else if (action === 'businessProfile') {
        this.store.commit(d => { this.business(d).name = required(input.name, 'Company name'); });
      } else if (action === 'updateAnswer') {
        this.store.commit(d => { const answer = this.business(d).interview.find(a => a.id === input.answerId); if (!answer) throw new Error('Answer not found.'); answer.answer = required(input.answer, 'Answer'); });
      } else if (action === 'saveBrief') {
        this.store.commit(d => { const current = this.business(d); current.brief = { ...(current.brief || { observations: [], suggestions: [], sources: [], mode: 'manual' }), summary: required(input.summary, 'Company description'), confirmed: true }; current.goal = required(input.goal, 'Training goal'); });
      } else if (action === 'question') {
        if (!b.brief?.confirmed) throw new Error('Confirm the company brief first.');
        const businessId = b.id;
        result = await this.brain.question(structuredClone(b));
        this.store.commit(d => { const current = d.businesses.find(b => b.id === businessId); current.nextQuestion = result; });
      } else if (action === 'answer') {
        if (!b.nextQuestion?.question) throw new Error('There is no pending question.');
        const entry = { id: id(), question: b.nextQuestion.question, answer: input.skip ? '(Skipped)' : required(input.answer, 'Answer'), at: now(), userId: this.userId };
        const updated = structuredClone(b); updated.interview.push(entry);
        result = await this.brain.question(updated);
        // Commit the answer and its next question together so failed AI requests can be retried.
        this.store.commit(d => { const current = this.business(d); current.interview.push(entry); current.nextQuestion = result; });
      } else if (action === 'generatePlan') {
        if (!b.brief?.confirmed || b.interview.length < 1) throw new Error('Confirm the brief and answer at least one interview question first.');
        result = await this.brain.plan(structuredClone(b));
        this.store.commit(d => { const current = this.business(d); for (const item of result.items.slice(0, 15)) { if (!current.skills.some(s => !s.archived && s.title.toLowerCase() === text(item.title).toLowerCase())) current.skills.push(this.makeSkill(item, this.userId)); } current.planNote = result.note; current.planConfirmed = false; });
      } else if (action === 'confirmPlan') {
        if (!b.skills.some(s => !s.archived)) throw new Error('Add at least one procedure to your plan.');
        this.store.commit(d => { const current = this.business(d); current.planConfirmed = true; current.onboardingComplete = true; });
      } else if (action === 'addSkill') {
        this.store.commit(d => { const current = this.business(d); const skill = this.makeSkill(input, this.userId); current.skills.push(skill); result = { skillId: skill.id }; });
      } else if (['updateSkill', 'archiveSkill', 'reorderSkill'].includes(action)) {
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.revision(sk, input.revision);
          if (action === 'archiveSkill') { sk.archived = true; current.paths.forEach(p => { p.skillIds = p.skillIds.filter(s => s !== sk.id); }); }
          if (action === 'reorderSkill') { const position = current.skills.indexOf(sk), target = Math.max(0, Math.min(current.skills.length - 1, position + (input.direction === 'up' ? -1 : 1))); current.skills.splice(position, 1); current.skills.splice(target, 0, sk); }
          if (action === 'updateSkill') {
            sk.title = required(input.title, 'Procedure title'); sk.outcome = text(input.outcome); sk.priority = ['essential', 'useful', 'later'].includes(input.priority) ? input.priority : sk.priority;
            sk.expertIds = [...new Set((input.expertIds || []).filter(uid => current.members.some(m => m.userId === uid && (m.roles.includes('expert') || m.roles.includes('admin')))))];
            if (!current.members.some(m => m.userId === input.leadId && (m.roles.includes('expert') || m.roles.includes('admin')))) throw new Error('Choose an expert or admin as lead reviewer.');
            sk.leadId = input.leadId;
            if (!sk.expertIds.includes(sk.leadId)) sk.expertIds.push(sk.leadId);
          } sk.revision++;
        });
      } else if (action === 'invite') {
        const email = required(input.email, 'Email').toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
        if (b.members.some(m => this.store.data.users.find(u => u.id === m.userId)?.email === email)) throw new Error('This person is already a member.');
        const roles = roleList(input.roles);
        this.store.commit(d => { const invite = { id: id(), token: crypto.randomBytes(18).toString('hex'), email, name: text(input.name, 100), roles, businessId: b.id, status: 'pending', createdAt: now(), expiresAt: now() + 7 * 86400000 }; d.invites.push(invite); result = invite; });
      } else if (action === 'acceptInvite') {
        // Dummy account acceptance for the demo: no email delivery or authentication.
        const invitation = this.store.data.invites.find(i => i.id === input.inviteId && i.businessId === b.id && i.status === 'pending' && i.expiresAt > now());
        this.admin(b); if (!invitation) throw new Error('Invitation has expired or is no longer available.');
        this.store.commit(d => { const invitation = d.invites.find(i => i.id === input.inviteId); let user = d.users.find(u => u.email === invitation.email); if (!user) { user = { id: id(), name: invitation.name || invitation.email.split('@')[0], email: invitation.email }; d.users.push(user); } const current = this.business(d); if (!current.members.some(m => m.userId === user.id)) current.members.push({ userId: user.id, roles: invitation.roles, joinedAt: now() }); invitation.status = 'accepted'; result = { userId: user.id }; });
      } else if (action === 'revokeInvite') {
        this.store.commit(d => { const invite = d.invites.find(i => i.id === input.inviteId && i.businessId === b.id); if (!invite) throw new Error('Invitation not found.'); invite.status = 'revoked'; });
      } else if (action === 'updateMember') {
        const roles = roleList(input.roles);
        this.store.commit(d => { const current = this.business(d), member = current.members.find(m => m.userId === input.userId); if (!member) throw new Error('Member not found.'); if (member.roles.includes('admin') && !roles.includes('admin') && current.members.filter(m => m.roles.includes('admin')).length === 1) throw new Error('Keep at least one admin.'); member.roles = roles; });
      } else if (action === 'createPath' || action === 'updatePath') {
        this.store.commit(d => { const current = this.business(d); const skillIds = [...new Set((input.skillIds || []).filter(sid => current.skills.some(s => s.id === sid && !s.archived && s.versions.length)))]; if (!skillIds.length) throw new Error('Choose at least one approved procedure.'); const learnerIds = [...new Set((input.learnerIds || []).filter(uid => current.members.some(m => m.userId === uid && m.roles.includes('learner'))))]; let p = current.paths.find(p => p.id === input.pathId); if (action === 'updatePath' && !p) throw new Error('Learning path not found.'); if (!p) { p = { id: id() }; current.paths.push(p); } Object.assign(p, { title: required(input.title, 'Learning path title'), role: text(input.role), skillIds, learnerIds, signoff: Boolean(input.signoff) }); });
      } else if (action === 'saveDraft') {
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.lead(sk, current); this.revision(sk, input.revision); sk.draft = mapFrom(input.map); sk.revision++; sk.lastEditedBy = this.userId; });
      } else if (action === 'contribute') {
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.expert(sk, current); const c = { id: id(), userId: this.userId, at: now(), kind: 'note', note: required(input.note, 'Contribution'), status: 'pending' }; sk.contributions.push(c); sk.revision++; result = c; });
      } else if (action === 'recording') {
        result = this.attachRecording(input.skillId, input.map, input.session, input.localId);
      } else if (action === 'refine') {
        const sk = this.skill(input.skillId); this.expert(sk); const c = sk.contributions.find(c => c.id === input.contributionId); if (!c) throw new Error('Contribution not found.');
        const revision = sk.revision; const proposal = await this.brain.refinement(structuredClone(sk), structuredClone(c));
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.revision(sk, revision); const c = sk.contributions.find(c => c.id === input.contributionId); c.proposal = proposal.proposal; for (const question of proposal.questions) sk.questions.push({ id: id(), text: question, contributionId: c.id, resolution: null }); sk.revision++; });
      } else if (action === 'reviewContribution') {
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.lead(sk, current); this.revision(sk, input.revision); const c = sk.contributions.find(c => c.id === input.contributionId); if (!c) throw new Error('Contribution not found.'); const decision = required(input.decision, 'Review decision'); if (!['incorporated', 'alternative', 'rejected'].includes(input.status)) throw new Error('Choose a contribution outcome.'); c.status = input.status; c.review = { userId: this.userId, decision, at: now() }; sk.revision++; });
      } else if (action === 'useRecording') {
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.lead(sk, current); this.revision(sk, input.revision); const c = sk.contributions.find(c => c.id === input.contributionId); if (!c?.map) throw new Error('This contribution has no recording.'); sk.draft = structuredClone(c.map); sk.draftSession = c.session; sk.revision++; });
      } else if (action === 'addQuestion' || action === 'resolveQuestion') {
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.expert(sk, current); this.revision(sk, input.revision); if (action === 'addQuestion') sk.questions.push({ id: id(), text: required(input.text, 'Question'), userId: this.userId, resolution: null }); else { this.lead(sk, current); const q = sk.questions.find(q => q.id === input.questionId); if (!q) throw new Error('Question not found.'); q.resolution = { text: required(input.resolution, 'Resolution'), userId: this.userId, at: now() }; } sk.revision++; });
      } else if (action === 'approve') {
        this.store.commit(d => { const current = this.business(d), sk = this.skill(input.skillId, current); this.lead(sk, current); this.revision(sk, input.revision); if (!sk.draft?.steps.length) throw new Error('Add a guide with at least one step.'); if (sk.versions.at(-1)?.revision === sk.revision - 1) throw new Error('The current draft is already approved. Make a reviewed change before publishing another version.'); if (sk.questions.some(q => !q.resolution) || sk.draft.open_questions?.length) throw new Error('Resolve open questions before approval, including those in the draft guide.'); if (sk.contributions.some(c => c.status === 'pending')) throw new Error('Review each expert contribution before approval.'); const version = { number: sk.versions.length + 1, map: { ...structuredClone(sk.draft), confirmed: true }, session: structuredClone(sk.draftSession || { events: [], qas: [], startedAt: now() }), approvedBy: this.userId, approvedAt: now(), contributors: [...new Set(sk.contributions.filter(c => c.status !== 'rejected').map(c => c.userId))], revision: sk.revision }; sk.versions.push(version); sk.revision++; result = { version: version.number }; });
      } else if (action === 'startAttempt') {
        result = this.startAttempt(input.skillId);
      } else if (action === 'completeAttempt') {
        const a = b.attempts.find(a => a.id === input.attemptId && a.userId === this.userId); if (!a || !this.assigned(a.skillId)) throw new Error('Training attempt is not assigned to you.'); if (a.status !== 'in_progress') throw new Error('This attempt is already completed.');
        this.store.commit(d => { const current = this.business(d), attempt = current.attempts.find(a => a.id === input.attemptId); attempt.status = attempt.signoff ? 'awaiting_signoff' : 'completed_with_guidance'; attempt.completedAt = now(); attempt.completionSource = 'demo_walkthrough'; });
      } else if (action === 'signoff') {
        this.store.commit(d => { const current = this.business(d), attempt = current.attempts.find(a => a.id === input.attemptId); if (!attempt) throw new Error('Attempt not found.'); const sk = this.skill(attempt.skillId, current); this.lead(sk, current); if (!['awaiting_signoff', 'completed_with_guidance'].includes(attempt.status)) throw new Error('Training must be completed before sign-off.'); attempt.status = 'signed_off'; attempt.signedOffBy = this.userId; attempt.signoffNote = required(input.note, 'Sign-off note'); attempt.signedOffAt = now(); });
      } else if (action === 'profile') {
        this.store.commit(d => { d.users.find(u => u.id === this.userId).name = required(input.name, 'Display name'); });
      } else throw new Error('Unknown workspace action.');
    }
    return { state: this.snapshot(), result };
  }
  recordingContext(skillId) {
    const sk = this.skill(skillId); this.expert(sk);
    return { businessId: this.businessId, userId: this.userId, skillId, title: sk.title };
  }
  attachRecording(skillId, map, session, localId, context = null) {
    if (context && (context.businessId !== this.businessId || context.userId !== this.userId)) throw new Error('Return to the account that started this recording.');
    let result;
    this.store.commit(d => { const b = this.business(d), sk = this.skill(skillId, b); this.expert(sk, b); const c = { id: id(), userId: this.userId, at: now(), kind: 'recording', map: mapFrom(map), session: session || { events: [], qas: [] }, localId: text(localId, 200), status: 'pending' }; sk.contributions.push(c); if (!sk.draft) { sk.draft = structuredClone(c.map); sk.draftSession = c.session; } sk.revision++; result = c; });
    return result;
  }
  startAttempt(skillId) {
    const sk = this.skill(skillId);
    if (!this.assigned(skillId)) throw new Error('This procedure is not assigned to you as a learner.');
    if (!sk.versions.length) throw new Error('This procedure has not been approved.');
    const existing = this.business().attempts.find(a => a.skillId === skillId && a.userId === this.userId && a.status === 'in_progress');
    if (existing) return { attempt: existing, version: sk.versions.find(v => v.number === existing.version) };
    let attempt;
    this.store.commit(d => { const b = this.business(d); attempt = { id: id(), userId: this.userId, skillId, version: sk.versions.at(-1).number, status: 'in_progress', startedAt: now(), signoff: b.paths.some(p => p.learnerIds.includes(this.userId) && p.skillIds.includes(skillId) && p.signoff) }; b.attempts.push(attempt); });
    return { attempt, version: sk.versions.at(-1) };
  }
  finishDesktopAttempt(context) {
    this.store.commit(d => { const b = d.businesses.find(b => b.id === context.businessId), a = b?.attempts.find(a => a.id === context.attemptId && a.userId === context.userId); if (a?.status === 'in_progress') { a.status = a.signoff ? 'awaiting_signoff' : 'completed_with_guidance'; a.completedAt = now(); a.completionSource = 'friday_lesson'; } });
  }
}
module.exports = { WorkspaceService, mapFrom };
