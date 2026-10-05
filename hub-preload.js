const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  list: () => ipcRenderer.invoke('hub-list'),
  remove: (id) => ipcRenderer.invoke('hub-delete', id),
  reveal: (id) => ipcRenderer.send('hub-reveal', id),
  openExternal: (id) => ipcRenderer.send('hub-open-external', id),
  teach: () => ipcRenderer.send('hub-teach'),
  onChanged: (fn) => ipcRenderer.on('hub-changed', (_e, select) => fn(select)),
});
