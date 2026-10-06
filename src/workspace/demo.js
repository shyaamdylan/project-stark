// Fictional, opt-in fixtures for demonstrating a multi-expert workflow.
const crypto = require('crypto');
const id = () => crypto.randomUUID();
function demoWorkspace(ownerId) {
  const experts = [{ id: id(), name: 'Alex Morgan', email: 'alex@example.test' }, { id: id(), name: 'Sam Patel', email: 'sam@example.test' }];
  const learner = { id: id(), name: 'Taylor Reed', email: 'taylor@example.test' };
  const map = { title: 'Check an incoming invoice', summary: 'Verify invoice details before entering an approved invoice into the accounting system.', prerequisites: ['An invoice and its purchase order', 'Access to the accounting app'], open_questions: [], teach_back: '', confirmed: false, steps: [
    { title: 'Open the invoice', action: 'Open the incoming invoice and its purchase order.', event_ids: [], is_judgment: false, decision: null, reason: null, rule: null, guardrails: [] },
    { title: 'Verify the details', action: 'Compare the supplier, amount and purchase order reference.', event_ids: [], is_judgment: true, decision: 'If the amount differs, stop and ask the finance lead.', reason: 'We need approval before entering an unmatched amount.', rule: 'Only continue when the details match.', guardrails: [{ kind: 'stop_and_ask', text: 'Escalate any amount mismatch to the finance lead.', qa_id: null }] },
    { title: 'Record the checked invoice', action: 'Enter the verified details into the accounting app and save the record.', event_ids: [], is_judgment: false, decision: null, reason: null, rule: null, guardrails: [] },
  ] };
  const skillId = id();
  const business = { id: id(), name: 'Northstar Services', website: '', goal: 'Help new accounts assistants check invoices independently.', brief: { summary: 'A fictional services business used to explore Friday’s onboarding and training workflow.', confirmed: true, observations: [], suggestions: [], sources: [], mode: 'demo' }, interview: [{ id: id(), question: 'Who should Friday train first?', answer: 'New accounts assistants, starting with invoice checks.', at: Date.now(), userId: ownerId }], nextQuestion: { complete: true, question: '', reason: '', mode: 'demo' }, planConfirmed: true, onboardingComplete: true,
    members: [{ userId: ownerId, roles: ['admin', 'expert'] }, ...experts.map(u => ({ userId: u.id, roles: ['expert'] })), { userId: learner.id, roles: ['learner'] }],
    skills: [{ id: skillId, title: map.title, outcome: 'Check standard invoices and escalate mismatches correctly.', priority: 'essential', rationale: 'New accounts assistants need this before working independently.', expertIds: experts.map(u => u.id), leadId: experts[0].id, revision: 1, draft: map, draftSession: { events: [], qas: [] }, contributions: [
      { id: id(), userId: experts[0].id, at: Date.now(), kind: 'note', note: 'Supplier, amount and purchase order must all match. Escalate mismatches.', status: 'pending' },
      { id: id(), userId: experts[1].id, at: Date.now(), kind: 'note', note: 'Some teams enter the invoice before checking the amount. Which approach should new starters use?', status: 'pending' },
    ], questions: [{ id: id(), text: 'Should the amount be checked before entry, or afterward? Agree the required order for new starters.', userId: experts[1].id, resolution: null }], versions: [], archived: false, createdAt: Date.now() }], paths: [], attempts: [] };
  return { users: [...experts, learner], business };
}
module.exports = { demoWorkspace };
