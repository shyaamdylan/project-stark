const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  ask: (text) => ipcRenderer.invoke('ask', text),
  speak: (text) => ipcRenderer.invoke('speak', text),
  setInteractive: (on) => ipcRenderer.send('set-interactive', on),
  openPrompt: () => ipcRenderer.send('open-prompt'),
  promptClosed: () => ipcRenderer.send('prompt-closed'),
  on: (channel, fn) => {
    const allowed = ['cursor', 'open-prompt', 'say', 'config', 'relocated'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
