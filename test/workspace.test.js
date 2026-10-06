const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceService } = require('../src/workspace/service');
const { Store } = require('../src/workspace/store');
const { Intelligence } = require('../src/workspace/intelligence');
const { ingestWebsite, publicAddress } = require('../src/workspace/website');
function fixture(t, intelligence = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-workspace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new WorkspaceService(path.join(dir,'workspace.json'), { intelligence: intelligence || new Intelligence('') });
}
const request = (service, action, input) => service.request(action, input);
async function approveFixture(s) {
  let sk=s.business().skills[0];
  for(const c of sk.contributions) {await request(s,'reviewContribution',{skillId:sk.id,contributionId:c.id,revision:s.skill(sk.id).revision,status:c===sk.contributions[0]?'incorporated':'rejected',decision:'Require checks before entry; reflected in the draft.'});}
  await request(s,'resolveQuestion',{skillId:sk.id,questionId:sk.questions[0].id,revision:s.skill(sk.id).revision,resolution:'Check the amount before entering the invoice.'});
  await request(s,'approve',{skillId:sk.id,revision:s.skill(sk.id).revision});
  return s.skill(sk.id);
}
test('multi-expert approval requires review and conflict resolution; published versions are immutable',async t=>{
  const s=fixture(t);await request(s,'loadDemo');let sk=s.business().skills[0];
  await assert.rejects(request(s,'approve',{skillId:sk.id,revision:sk.revision}),/Resolve open questions/);
  sk=await approveFixture(s);const original=structuredClone(sk.versions[0]);
  await assert.rejects(request(s,'approve',{skillId:sk.id,revision:sk.revision}),/already approved/);
  const map=structuredClone(sk.draft);map.steps[0].action='Open the document from the shared inbox.';
  await request(s,'saveDraft',{skillId:sk.id,revision:sk.revision,map});
  assert.deepEqual(s.skill(sk.id).versions[0],original);
  await assert.rejects(request(s,'saveDraft',{skillId:sk.id,revision:sk.revision,map}),/changed/);
  await request(s,'approve',{skillId:sk.id,revision:s.skill(sk.id).revision});assert.equal(s.skill(sk.id).versions.length,2);
});
test('learner only sees assigned approved guides; attempts remain pinned across later approvals',async t=>{
  const s=fixture(t);await request(s,'loadDemo');const owner=s.userId;let sk=await approveFixture(s);
  const learner=s.business().members.find(m=>m.roles.includes('learner')).userId;
  await request(s,'createPath',{title:'Starter path',role:'Assistant',skillIds:[sk.id],learnerIds:[learner],signoff:true});
  await request(s,'switchAccount',{userId:learner});
  const visible=s.snapshot().business.skills[0];assert.equal(visible.draft,undefined);assert.equal(visible.contributions,undefined);assert.equal(visible.questions,undefined);
  await assert.rejects(request(s,'addSkill',{title:'Unauthorized'}),/admin/);
  await assert.rejects(request(s,'approve',{skillId:sk.id,revision:sk.revision}),/expert/);
  const {result:first}=await request(s,'startAttempt',{skillId:sk.id});assert.equal(first.attempt.version,1);
  await request(s,'switchAccount',{userId:owner});sk=s.skill(sk.id);const map=structuredClone(sk.draft);map.summary='A reviewed improvement.';
  await request(s,'saveDraft',{skillId:sk.id,revision:sk.revision,map});await request(s,'approve',{skillId:sk.id,revision:s.skill(sk.id).revision});
  await request(s,'switchAccount',{userId:learner});const {result:resumed}=await request(s,'startAttempt',{skillId:sk.id});assert.equal(resumed.version.number,1);assert.equal(resumed.attempt.id,first.attempt.id);
  await request(s,'completeAttempt',{attemptId:first.attempt.id});assert.equal(s.business().attempts[0].status,'awaiting_signoff');
  await assert.rejects(request(s,'signoff',{attemptId:first.attempt.id,note:'Self approval'}),/expert/);
  await request(s,'switchAccount',{userId:owner});await request(s,'signoff',{attemptId:first.attempt.id,note:'Observed independent completion.'});assert.equal(s.business().attempts[0].status,'signed_off');
});
test('unassigned experts cannot change a skill and non-leads cannot approve',async t=>{
  const s=fixture(t);await request(s,'loadDemo');const sk=s.business().skills[0],second=s.business().members[2].userId;
  await request(s,'switchAccount',{userId:second});await request(s,'contribute',{skillId:sk.id,note:'Remember to check the date.'});
  await assert.rejects(request(s,'saveDraft',{skillId:sk.id,revision:s.skill(sk.id).revision,map:sk.draft}),/lead/);
  await assert.rejects(request(s,'approve',{skillId:sk.id,revision:s.skill(sk.id).revision}),/lead/);
});
test('demo invitations support dual roles, revocation and last-admin protection',async t=>{
  const s=fixture(t);await request(s,'createBusiness',{name:'Example Workshop'});
  const {result:i}=await request(s,'invite',{email:'expert@example.test',name:'Casey',roles:['expert','learner']});
  const {result:u}=await request(s,'acceptInvite',{inviteId:i.id});assert.deepEqual(s.business().members.find(m=>m.userId===u.userId).roles,['expert','learner']);
  await assert.rejects(request(s,'updateMember',{userId:s.userId,roles:['expert']}),/at least one admin/);
  const {result:r}=await request(s,'invite',{email:'other@example.test',roles:['learner']});await request(s,'revokeInvite',{inviteId:r.id});await assert.rejects(request(s,'acceptInvite',{inviteId:r.id}),/expired/);
});
test('business isolation and draft protection persist after role changes',async t=>{
  const s=fixture(t);await request(s,'loadDemo');const originalId=s.businessId, owner=s.userId,sk=s.business().skills[0],expert=s.business().members[1].userId;
  await request(s,'updateMember',{userId:expert,roles:['learner']});await request(s,'switchAccount',{userId:expert});assert.equal(s.snapshot().business.skills.length,0);
  await request(s,'createBusiness',{name:'Second Workshop'});await assert.rejects(request(s,'contribute',{skillId:sk.id,note:'Cross business'}),/not found/);
  await request(s,'switchAccount',{userId:owner});await request(s,'switchBusiness',{businessId:originalId});assert.equal(s.business().name,'Northstar Services');
});
test('approved-only path creation and archive preserve prior records',async t=>{
  const s=fixture(t);await request(s,'loadDemo');let sk=s.business().skills[0];await assert.rejects(request(s,'createPath',{title:'Premature path',skillIds:[sk.id],learnerIds:[]}),/approved/);
  sk=await approveFixture(s);const learner=s.business().members.find(m=>m.roles.includes('learner')).userId;
  await request(s,'createPath',{title:'Starter',skillIds:[sk.id],learnerIds:[learner]});await request(s,'switchAccount',{userId:learner});await request(s,'startAttempt',{skillId:sk.id});const owner=s.business().members[0].userId;await request(s,'switchAccount',{userId:owner});await request(s,'archiveSkill',{skillId:sk.id,revision:sk.revision});assert.equal(s.business().attempts.length,1);assert.deepEqual(s.business().paths[0].skillIds,[]);
});
test('workspace writes are atomic; rejected mutations do not corrupt state',t=>{
  const s=fixture(t);const before=structuredClone(s.store.data);assert.throws(()=>s.store.commit(d=>{d.users=[];throw new Error('Invalid mutation');}));assert.deepEqual(s.store.data,before);const disk=new Store(s.store.file);assert.deepEqual(disk.data,before);
});
test('website ingestion excludes scripts, follows relevant pages, and rejects local addresses',async()=>{
  assert.equal(publicAddress('127.0.0.1'),false);assert.equal(publicAddress('10.0.1.2'),false);assert.equal(publicAddress('::1'),false);assert.equal(publicAddress('::ffff:127.0.0.1'),false);assert.equal(publicAddress('8.8.8.8'),true);
  const pages=await ingestWebsite('https://example.test',async url=>({url,html:`<main>A business that provides services to local customers and teaches staff safe ways of working. ${url}</main><a href="/about">About</a><script>malicious()</script>`}));
  assert.equal(pages.length,2);assert.ok(pages.every(p=>!p.text.includes('malicious')));
});
test('tailored interview passes company brief and previous answers as data; manual mode is explicit',async()=>{
  const calls=[];const ai={json:async(system,user)=>{calls.push({system,user:JSON.parse(user)});return{question:'Which tool does the service desk use?',reason:'Understand the workflow.',complete:false};}};
  const brain=new Intelligence('test',{ai});const business={brief:{summary:'A service desk'},goal:'Train coordinators',interview:[{question:'What role?',answer:'Coordinators handling urgent requests.'}]};const q=await brain.question(business);assert.equal(q.mode,'ai');assert.deepEqual(calls[0].user.answers,business.interview);assert.ok(calls[0].system.includes('untrusted data'));
  const manual=new Intelligence('');const p=await manual.plan(business);assert.equal(p.mode,'manual');assert.equal(p.items.length,0);
});
test('company brief confirmation gates interview and editable answers drive later planning',async t=>{
  const intelligence={ai:{},brief:async()=>({summary:'A workshop',observations:[],suggestions:[],sources:[],mode:'ai',confirmed:false}),question:async b=>({question:b.interview.length?'Which tool?':'Who should learn?',reason:'Focus',complete:false,mode:'ai'}),plan:async b=>({items:[{title:'Check a service request',outcome:b.interview[0].answer,priority:'essential'}],note:'Review this suggestion.'})};
  const s=fixture(t,intelligence);await request(s,'createBusiness',{name:'Example Workshop'});await assert.rejects(request(s,'question'),/Confirm/);await request(s,'ingest',{description:'Workshop'});await request(s,'saveBrief',{summary:'Confirmed workshop',goal:'Train coordinators'});await request(s,'question');await request(s,'answer',{answer:'New coordinators'});const a=s.business().interview[0];await request(s,'updateAnswer',{answerId:a.id,answer:'Experienced coordinators'});await request(s,'generatePlan');assert.equal(s.business().skills[0].outcome,'Experienced coordinators');await request(s,'confirmPlan');assert.equal(s.business().onboardingComplete,true);
});
test('a failed interview request preserves the pending question and allows retry without duplicating the answer',async t=>{
  let fail=false;
  const intelligence={ai:{},brief:async()=>({summary:'Workshop',observations:[],suggestions:[],sources:[],confirmed:false}),question:async()=>{if(fail)throw new Error('Provider temporarily unavailable');return{question:'Which tool?',reason:'Understand the system',complete:false};}};
  const s=fixture(t,intelligence);await request(s,'createBusiness',{name:'Retry Workshop'});await request(s,'ingest',{description:'Workshop'});await request(s,'saveBrief',{summary:'Workshop',goal:'Train a coordinator'});await request(s,'question');fail=true;await assert.rejects(request(s,'answer',{answer:'Service desk'}),/temporarily/);assert.equal(s.business().interview.length,0);assert.equal(s.business().nextQuestion.question,'Which tool?');fail=false;await request(s,'answer',{answer:'Service desk'});assert.equal(s.business().interview.length,1);
});
