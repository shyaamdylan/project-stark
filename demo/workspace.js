// Interactive local demo of the business workflow, without the desktop overlay.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { WorkspaceService } = require('../src/workspace/service');
const { listRecordings, recordingDetails, recordingDir } = require('../src/local-recordings');
const { loadConfig } = require('../src/config');
app.setName('Stark Workspace Demo');
let window, backend;
let queue = Promise.resolve();
ipcMain.handle('workspace-request', (event, action, input = {}) => {
  if (!window || event.sender !== window.webContents) return { error: 'Open the workspace window.' };
  const run = async () => {
    try {
      if (['recordProcedure', 'desktopTraining'].includes(action)) throw new Error('Use npm start for live recording and desktop training. This standalone demo supports guide editing and demo walkthroughs.');
      return await backend.request(action, input);
    } catch(error) { return { error: error.message }; }
  };
  const result = queue.then(run,run); queue = result.then(()=>{},()=>{}); return result;
});
// The standalone demo previews the full app's real library without moving its files.
const recordingsRoot = () => path.join(app.getPath('appData'), 'Project Stark', 'workmaps');
ipcMain.handle('hub-info', () => ({ desktopAvailable: false }));
ipcMain.handle('hub-list', () => listRecordings(recordingsRoot()));
ipcMain.handle('hub-skill', (_event, id) => recordingDetails(recordingsRoot(), id));
ipcMain.on('hub-open-external', (_event,id) => { const dir=recordingDir(recordingsRoot(),id); if(dir)shell.openPath(path.join(dir,'index.html')); });
ipcMain.on('hub-reveal', (_event,id) => { const dir=recordingDir(recordingsRoot(),id); if(dir)shell.showItemInFolder(dir); });
app.whenReady().then(() => {
  backend = new WorkspaceService(path.join(app.getPath('userData'),'workspace-demo.json'), { apiKey:loadConfig(app.getPath('userData')).anthropicApiKey });
  window = new BrowserWindow({width:1180,height:780,minWidth:820,minHeight:640,title:'Stark · Business demo',titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18},backgroundColor:'#101114',webPreferences:{preload:path.join(__dirname,'..','hub-preload.js'),contextIsolation:true,nodeIntegration:false}});
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return {action:'deny'}; });
  window.loadFile(path.join(__dirname,'..','renderer','app','index.html'), { query: { view: process.argv.includes('--recordings') ? 'recordings' : '' } });
  window.on('closed',()=>{ window=null;app.quit(); });
});
