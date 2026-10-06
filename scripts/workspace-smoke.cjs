// Runs the real renderer against a temporary dummy backend. No voice or paid AI calls.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceService } = require('../src/workspace/service');
const { Intelligence } = require('../src/workspace/intelligence');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stark-ui-smoke-'));
app.setPath('userData', path.join(temp, 'electron'));
const backend = new WorkspaceService(path.join(temp, 'workspace.json'), { intelligence: new Intelligence('') });
ipcMain.handle('workspace-request', async (_event, action, input) => { try { return await backend.request(action, input); } catch(error) { return { error:error.message }; } });
ipcMain.handle('hub-info', () => ({ desktopAvailable: true }));
ipcMain.handle('hub-list', () => []);
let win;
const evaluate = code => win.webContents.executeJavaScript(code.startsWith('const ') ? '{' + code + '}' : code);
async function until(expression) {
  const deadline = Date.now()+10000;
  while(Date.now()<deadline) { if(await evaluate(expression))return; await new Promise(r=>setTimeout(r,50)); }
  throw new Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText'));
}
async function click(selector, ready) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); if(ready)await until(ready); }
async function capture(name) { await new Promise(r=>setTimeout(r,250)); const im=await win.webContents.capturePage();fs.writeFileSync(path.join('/tmp',name),im.toPNG()); }
app.whenReady().then(async()=>{
  win=new BrowserWindow({width:1180,height:780,show:false,webPreferences:{preload:path.join(root,'hub-preload.js'),contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message', event=>{if(event.level==='error')console.error('renderer:',event.message);});
  await win.loadFile(path.join(root,'renderer/app/index.html'));
  await until(`document.querySelector('[data-form="createBusiness"]')!==null`);
  await click('nav [data-page="recordings"]');
  await until(`document.getElementById('recordings-frame').contentDocument.getElementById('library-meta').textContent==='0 procedures'`);
  await click('nav [data-page="setup"]');
  await capture('stark-business-onboarding.png');
  await click('[data-action="loadDemo"]',`document.querySelector('#plan-root').textContent.includes('Check an incoming invoice')`);
  await capture('stark-teaching-plan.png');
  await click('#plan-root [data-action="openSkill"]',`document.querySelector('#procedure-root .contribution')!==null`);
  // Two experts disagree. The lead resolves the question and reviews both contributions.
  await evaluate(`document.querySelector('#demo-account').value=${JSON.stringify(backend.business().members[1].userId)}; document.querySelector('#demo-account').dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.querySelector('#profile-name').textContent==='Alex Morgan'`);
  await click('nav [data-page="skills"]'); await click('#skill-library [data-action="openSkill"]');
  await capture('stark-expert-review.png');
  await click('[data-action="editDraft"]');
  await evaluate(`document.querySelector('#draft-form').elements.summary.value='A refined guide for new accounts assistants.'; document.querySelector('#draft-form').requestSubmit()`);
  await until(`document.querySelector('#guide-view').textContent.includes('A refined guide for new accounts assistants.') && document.querySelector('#draft-form')===null`);
  for(let i=0;i<2;i++){
    await evaluate(`const form=document.querySelector('[data-form="reviewContribution"]'); form.elements.decision.value='Check before entry; the draft reflects this agreed policy.'; form.elements.status.value='${i?'rejected':'incorporated'}'; form.requestSubmit()`);
    await until(`document.querySelectorAll('[data-form="reviewContribution"]').length===${1-i}`);
  }
  await evaluate(`const form=document.querySelector('[data-form="resolveQuestion"]');form.elements.resolution.value='Verify invoice amount before entering the record.';form.requestSubmit()`);
  await until(`document.querySelector('[data-form="resolveQuestion"]')===null`);
  await click('[data-action="approve"]',`document.querySelector('#procedure-root').textContent.includes('Approved · v1')`);
  await evaluate(`document.querySelector('#demo-account').value=${JSON.stringify(backend.business().members[0].userId)};document.querySelector('#demo-account').dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.querySelector('#profile-name').textContent==='Workspace owner'`);
  await click('nav [data-page="training"]');
  await evaluate(`const f=document.querySelector('[data-form="createPath"]');f.elements.title.value='New accounts assistant';f.elements.role.value='Accounts';f.querySelector('[name="skillIds"]').checked=true;f.querySelector('[name="learnerIds"]').checked=true;f.requestSubmit()`);
  await until(`document.querySelector('#training-root').textContent.includes('Assigned to: Taylor Reed')`);
  const learner=backend.business().members.find(m=>m.roles.includes('learner')).userId;
  await evaluate(`document.querySelector('#demo-account').value=${JSON.stringify(learner)};document.querySelector('#demo-account').dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.querySelector('#profile-name').textContent==='Taylor Reed'`);
  await click('nav [data-page="training"]'); await click('[data-action="walkthrough"]',`document.querySelector('.walkthrough')!==null`);
  await capture('stark-learner-training.png');
  for(let i=0;i<3;i++){await click('[data-action="nextLesson"]');await new Promise(r=>setTimeout(r,100));}
  await until(`document.querySelector('#training-root').textContent.includes('awaiting signoff')`);
  if(backend.business().attempts[0].version!==1)throw new Error('Attempt must use approved v1.');
  await evaluate(`document.querySelector('#demo-account').value=${JSON.stringify(backend.business().members[1].userId)};document.querySelector('#demo-account').dispatchEvent(new Event('change',{bubbles:true}))`);
  await until(`document.querySelector('#profile-name').textContent==='Alex Morgan'`);
  await click('nav [data-page="training"]');
  await evaluate(`const f=document.querySelector('[data-form="signoff"]');f.elements.note.value='Reviewed the demo completion.';f.requestSubmit()`);
  await until(`document.querySelector('#training-root').textContent.includes('signed off')`);
  // Exercise the real manual onboarding screens in a separate new workspace.
  await backend.request('createBusiness',{name:'Example Workshop',ownerName:'Demo Admin'});
  win.webContents.send('workspace-changed',{});await until(`document.querySelector('.workspace').textContent.includes('Example Workshop')`);
  await click('nav [data-page="setup"]');
  await evaluate(`const f=document.querySelector('[data-form="ingest"]');f.elements.description.value='A service business helping clients with repairs and maintenance.';f.requestSubmit()`);
  await until(`document.querySelector('[data-form="saveBrief"]')!==null`);
  await evaluate(`const f=document.querySelector('[data-form="saveBrief"]');f.elements.goal.value='Train a new coordinator to handle requests.';f.requestSubmit()`);
  await until(`document.querySelector('[data-form="answer"]')!==null`);
  await capture('stark-friday-interview.png');
  for(let i=0;i<6;i++){
    await evaluate(`const f=document.querySelector('[data-form="answer"]');f.elements.answer.value='Coordinators use a service desk app, with expert review for urgent requests.';f.requestSubmit()`);
    await until(i===5?`document.querySelector('[data-form="answer"]')===null`:`state.business.interview.length===${i+1} && !document.querySelector('#busy-status').classList.contains('hidden')===false`);
  }
  await click('#onboarding-step [data-action="generatePlan"]',`page==='plan'`);
  await evaluate(`const f=document.querySelector('[data-form="addSkill"]');f.elements.title.value='Triage a maintenance request';f.elements.outcome.value='Identify urgent requests and escalate safely.';f.requestSubmit()`);
  await until(`document.querySelector('#plan-root').textContent.includes('Triage a maintenance request')`);
  await click('#plan-root [data-action="editPlan"]');
  await evaluate(`const f=document.querySelector('[data-form="updateSkill"]');f.querySelector('[name="expertIds"]').checked=true;f.requestSubmit()`);
  await until(`document.querySelector('[data-form="updateSkill"]')===null`);
  await click('[data-action="confirmPlan"]',`page==='team'`);
  await evaluate(`const f=document.querySelector('[data-form="invite"]');f.elements.email.value='expert@example.test';f.elements.name.value='Demo Expert';f.requestSubmit()`);
  await until(`document.querySelector('[data-action="acceptInvite"]')!==null`);
  await click('[data-action="acceptInvite"]',`document.querySelector('#team-root').textContent.includes('Demo Expert') && document.querySelector('[data-action="acceptInvite"]')===null`);
  win.setSize(820,640);
  await evaluate(`navigate('team'); document.querySelector('#theme').value='light';document.querySelector('#theme').dispatchEvent(new Event('change',{bubbles:true}))`);
  await new Promise(r=>setTimeout(r,250));
  if(!await evaluate(`document.documentElement.scrollWidth===document.documentElement.clientWidth && document.querySelector('#team').scrollWidth===document.querySelector('#team').clientWidth`))throw new Error('Compact workspace overflows horizontally.');
  await capture('stark-workspace-compact-light.png');
  console.log('PASS: business setup, six-question interview, editable plan, invitation acceptance, two-expert review, conflict resolution, approval, path assignment, pinned learner walkthrough and expert sign-off.');
  console.log('Screenshots: /tmp/stark-business-onboarding.png, /tmp/stark-teaching-plan.png, /tmp/stark-expert-review.png, /tmp/stark-friday-interview.png, /tmp/stark-learner-training.png');
  win.destroy();app.exit(0);
}).catch(error=>{console.error(error);if(win)win.destroy();app.exit(1);});
process.on('exit',()=>{fs.rmSync(temp,{recursive:true,force:true});});
