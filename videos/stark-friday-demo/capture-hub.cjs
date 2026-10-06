const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');const fs=require('fs'),path=require('path'),os=require('os');
const root=path.resolve(__dirname,'../..'),dir=__dirname;app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'stark-film-hub-')));nativeTheme.themeSource='dark';
const {WorkspaceService}=require(path.join(root,'src/workspace/service'));const {Intelligence}=require(path.join(root,'src/workspace/intelligence'));const svc=new WorkspaceService(path.join(app.getPath('userData'),'workspace.json'),{intelligence:new Intelligence('')});
ipcMain.handle('workspace-request',async(_e,a,i)=>{try{return await svc.request(a,i)}catch(e){return{error:e.message}}});ipcMain.handle('hub-info',()=>({desktopAvailable:true}));ipcMain.handle('hub-list',()=>[]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
const learned=JSON.parse(fs.readFileSync(path.join(dir,'capture/learned-skill.json')));
await svc.request('createBusiness',{name:'Kestrel Manufacturing',ownerName:'Sabine Keller'});
const added=await svc.request('addSkill',{title:'Review a machinery invoice',outcome:'Classify equipment correctly and send it for approval.'});const sid=added.result.skillId;
const c=await svc.request('recording',{skillId:sid,map:learned.map,session:learned.session,localId:'film-expert-recording'});
let sk=()=>svc.business().skills[0];await svc.request('reviewContribution',{skillId:sid,contributionId:c.result.id,revision:sk().revision,status:'incorporated',decision:'Confirmed against the expert demonstration.'});
// Keep unresolved expert questions visible in the real working draft.
svc.store.commit(d=>{const b=d.businesses[0];b.onboardingComplete=true;b.planConfirmed=true;});
const w=new BrowserWindow({width:1440,height:900,useContentSize:true,show:false,transparent:true,backgroundColor:"#00000000",webPreferences:{preload:path.join(root,'hub-preload.js'),contextIsolation:true,nodeIntegration:false}});
await w.loadFile(path.join(root,'renderer/app/index.html'));await sleep(1000);await w.webContents.executeJavaScript(`navigate('skills');`);await sleep(450);fs.writeFileSync(path.join(dir,'assets/hub.png'),(await w.webContents.capturePage()).toPNG());
await w.webContents.executeJavaScript(`document.querySelector('#skill-library [data-action="openSkill"]').click()`);await sleep(500);fs.writeFileSync(path.join(dir,'assets/guide.png'),(await w.webContents.capturePage()).toPNG());
await w.webContents.executeJavaScript(`navigate('home')`);await sleep(400);await w.webContents.executeJavaScript(`const orb=document.querySelector('.product-orb').cloneNode(true);document.body.replaceChildren(orb);document.documentElement.style.background='transparent';document.body.style.cssText='background:transparent;display:block';orb.style.cssText='position:absolute;left:80px;top:80px;width:240px;height:240px;transform:none';`);await sleep(700);fs.writeFileSync(path.join(dir,'assets/orb.png'),(await w.webContents.capturePage({x:0,y:0,width:400,height:400})).toPNG());
console.log('HUB captured actual learned skill');w.destroy();app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
