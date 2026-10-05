const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  ask: (text, agent) => ipcRenderer.invoke('ask', text, agent),
  setAgent: (agent) => ipcRenderer.send('set-agent', agent),
  jarvisStop: () => ipcRenderer.send('jarvis-stop'),
  confirm: (text) => ipcRenderer.invoke('confirm', text),
  speak: (text) => ipcRenderer.invoke('speak', text),
  setInteractive: (on) => ipcRenderer.send('set-interactive', on),
  openPrompt: () => ipcRenderer.send('open-prompt'),
  focusOverlay: () => ipcRenderer.send('focus-overlay'),
  promptClosed: () => ipcRenderer.send('prompt-closed'),
  guideNext: () => ipcRenderer.send('guide-next'),
  guideStop: () => ipcRenderer.send('guide-stop'),
  guideSay: (text) => ipcRenderer.send('guide-say', text),
  teachStart: (title) => ipcRenderer.send('teach-start', title),
  teachFinish: () => ipcRenderer.send('teach-finish'),
  teachAnswer: (id, text) => ipcRenderer.send('teach-answer', { id, text }),
  teachOffRecord: (off) => ipcRenderer.send('teach-off-record', off),
  teachNarrate: (text) => ipcRenderer.send('teach-narrate', text),
  teachSpeaking: (on) => ipcRenderer.send('teach-speaking', on),
  transcribe: (wav) => ipcRenderer.invoke('transcribe', wav),
  openHub: () => ipcRenderer.send('open-hub'),
  on: (channel, fn) => {
    const allowed = ['cursor', 'open-prompt', 'say', 'config', 'relocated', 'guide-step', 'guide-thinking', 'teach-state', 'teach-question', 'teach-status', 'listen', 'wake', 'agent', 'jarvis-step', 'jarvis-state', 'question-cancel', 'layout'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
