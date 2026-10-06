const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  info: () => ipcRenderer.invoke('hub-info'),
  list: () => ipcRenderer.invoke('hub-list'),
  skill: (id) => ipcRenderer.invoke('hub-skill', id),
  learn: (id) => ipcRenderer.send('hub-learn', id),
  spot: (id) => ipcRenderer.send('hub-spot', id),
  exportForAgents: (id) => ipcRenderer.invoke('hub-export', id),
  remove: (id) => ipcRenderer.invoke('hub-delete', id),
  reveal: (id) => ipcRenderer.send('hub-reveal', id),
  openExternal: (id) => ipcRenderer.send('hub-open-external', id),
  teach: () => ipcRenderer.send('hub-teach'),
  run: (id) => ipcRenderer.send('hub-run', id),
  onChanged: (fn) => ipcRenderer.on('hub-changed', (_e, select) => fn(select)),
});

contextBridge.exposeInMainWorld('workspace', {
  request: (action, input = {}) => ipcRenderer.invoke('workspace-request', action, input),
  onChanged: (fn) => ipcRenderer.on('workspace-changed', (_event, data) => fn(data)),
});
