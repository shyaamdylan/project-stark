// Silent Electron regression check: the overlay moves clear and leaves the target click-through.
const {app,BrowserWindow,ipcMain}=require('electron');
const path = require('path');
const root = path.resolve(__dirname, '..');
const {avoid}=require('../src/avoid');
let win, box, target, mode={}, interactive=false;
function update(){if(!box||box.w<=0)return;const size=win.getContentBounds();const result=avoid({island:box,screen:{x:0,y:0,w:size.width,h:size.height},home:box.home,target,cursor:{x:0,y:0}},mode);mode=result.state;win.webContents.send('island-offset',{...result.offset,edge:result.edge});}
ipcMain.on('island-box',(_e,v)=>{box=v;update()});ipcMain.on('avoid-target',(_e,v)=>{if(v)target=v;update()});ipcMain.on('set-interactive',(_e,v)=>{interactive=v});
app.whenReady().then(async()=>{win=new BrowserWindow({width:1000,height:750,show:false,webPreferences:{preload:path.join(root,'preload.js'),contextIsolation:true,nodeIntegration:false}});win.webContents.on('console-message',e=>{if(e.level==='error')console.error(e.message)});await win.loadFile(path.join(root,'renderer','index.html'));win.webContents.send('layout',{mode:'island'});await new Promise(r=>setTimeout(r,200));await win.webContents.executeJavaScript(`state.resting=false;buddyEl.classList.add('awake');document.getElementById('bubble').classList.remove('hidden');document.getElementById('say').textContent='Click the control to continue.';fitShell();showSpot({x:innerWidth-170,y:innerHeight-95,w:140,h:40},'Continue')`);await new Promise(r=>setTimeout(r,900));const result=await win.webContents.executeJavaScript(`(()=>{const r=document.getElementById('shell').getBoundingClientRect(),t=state.protectedTarget;state.interactive=true;state.promptOpen=true;document.body.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:t.x+30,clientY:t.y+20}));return {clear:!(r.x<t.x+t.w&&t.x<r.right&&r.y<t.y+t.h&&t.y<r.bottom),clickThrough:!state.interactive,offset:getComputedStyle(document.body).getPropertyValue('--island-dy')}})()`);if(!result.clear||!result.clickThrough)throw new Error(JSON.stringify(result));console.log(result);
// A speech-only reference must move the UI without displaying a pointing ring.
await win.webContents.executeJavaScript(`clearPointing();state.promptOpen=false;document.getElementById('say').textContent='Dismiss the notice to continue.'`);
const {discussedControls}=require('../src/discussed-controls');
const size=win.getContentBounds();
const mentioned=discussedControls('Dismiss the notice to continue.',[{role:'AXButton',label:'Dismiss',x:size.width-170,y:size.height-95,w:140,h:40}])[0];
win.webContents.send('discussed-target',mentioned.rect);
await new Promise(r=>setTimeout(r,700));
const speechOnly=await win.webContents.executeJavaScript(`(()=>{const r=document.getElementById('shell').getBoundingClientRect(),t=state.protectedTarget;return {noPointer:document.getElementById('spot').classList.contains('hidden'),clear:!(r.x<t.x+t.w&&t.x<r.right&&r.y<t.y+t.h&&t.y<r.bottom)}})()`);
if(!speechOnly.noPointer||!speechOnly.clear)throw new Error(JSON.stringify(speechOnly));
console.log({speechOnly});win.destroy();app.exit(0)}).catch(e=>{console.error(e);app.exit(1)});
