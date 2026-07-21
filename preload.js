// preload.js — 安全暴露 IPC 给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orb', {
  // 悬浮球
  onState: (cb) => ipcRenderer.on('orb-state', (e, data) => cb(data)),
  toggleMonitor: () => ipcRenderer.send('toggle-monitor'),
  quit: () => ipcRenderer.send('quit-app'),
  getState: () => ipcRenderer.invoke('get-state'),
  // 建议弹窗
  onSuggestion: (cb) => ipcRenderer.on('suggestion', (e, data) => cb(data)),
  addTodo: (item) => ipcRenderer.send('add-todo', item),
  ignore: (item) => ipcRenderer.send('ignore-todo', item),
  // 工作台
  openWorkspace: () => ipcRenderer.send('open-workspace'),
  getRecall: () => ipcRenderer.invoke('workspace:getRecall'),
  getMeetings: () => ipcRenderer.invoke('workspace:getMeetings'),
  getRoutines: () => ipcRenderer.invoke('workspace:getRoutines'),
  getTimeline: () => ipcRenderer.invoke('workspace:getTimeline'),
  search: (q) => ipcRenderer.invoke('workspace:search', q),
});
