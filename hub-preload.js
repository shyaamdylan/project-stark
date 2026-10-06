const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  list: () => ipcRenderer.invoke('hub-list'),
  skill: (id) => ipcRenderer.invoke('hub-skill', id),
  learn: (id) => ipcRenderer.send('hub-learn', id),
  exportForAgents: (id) => ipcRenderer.invoke('hub-export', id),
  remove: (id) => ipcRenderer.invoke('hub-delete', id),
  reveal: (id) => ipcRenderer.send('hub-reveal', id),
  openExternal: (id) => ipcRenderer.send('hub-open-external', id),
  teach: () => ipcRenderer.send('hub-teach'),
  run: (id) => ipcRenderer.send('hub-run', id),
  onChanged: (fn) => ipcRenderer.on('hub-changed', (_e, select) => fn(select)),
});
