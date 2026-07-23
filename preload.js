// preload.js — 安全暴露 IPC 给渲染进程
// 注意:electron 默认 sandbox:true,preload 里只 require Electron 内置模块。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orb', {
  // 悬浮球
  onState: (cb) => ipcRenderer.on('orb-state', (e, data) => cb(data)),
  toggleMonitor: () => ipcRenderer.send('toggle-monitor'),
  quit: () => ipcRenderer.send('quit-app'),
  getState: () => ipcRenderer.invoke('get-state'),
  // 建议弹窗
  onSuggestion: (cb) => {
    const listener = (e, data) => cb(data);
    ipcRenderer.on('suggestion', listener);
    return () => { ipcRenderer.removeListener('suggestion', listener); };
  },
  addTodo: (item) => ipcRenderer.send('add-todo', item),
  ignore: (item) => ipcRenderer.send('ignore-todo', item),
  resizePopup: (height) => ipcRenderer.send('suggestion:resize', height),
  // 工作台
  openWorkspace: () => ipcRenderer.send('open-workspace'),
  getRecall: () => ipcRenderer.invoke('workspace:getRecall'),
  getMeetings: () => ipcRenderer.invoke('workspace:getMeetings'),
  getRoutines: () => ipcRenderer.invoke('workspace:getRoutines'),
  getTimeline: () => ipcRenderer.invoke('workspace:getTimeline'),
  search: (q) => ipcRenderer.invoke('workspace:search', q),
  getRejected: () => ipcRenderer.invoke('workspace:getRejected'),
  restoreRejected: (id) => ipcRenderer.invoke('workspace:restoreRejected', id),
  // 设置:读写 config.filter(黑/白名单)
  getFilter: () => ipcRenderer.invoke('settings:getFilter'),
  setFilter: (f) => ipcRenderer.send('settings:setFilter', f),
  getRunningProcesses: () => ipcRenderer.invoke('settings:running-processes'),
  // 工具可见性:查看 Agent 可访问工具 + 配置来源开关
  toolsList: () => ipcRenderer.invoke('tools:list'),
  toolsSetSources: (s) => ipcRenderer.send('tools:setSources', s),
  // 可引用文件列表(工作目录下 .md / .txt / .jsonl)
  listFiles: () => ipcRenderer.invoke('chat:list-files'),
  // 对话 Agent(agui 流式 + 多会话管理)
  listSessions: () => ipcRenderer.invoke('chat:list-sessions'),
  getSession: (id) => ipcRenderer.invoke('chat:get-session', id),
  createSession: () => ipcRenderer.invoke('chat:create-session'),
  deleteSession: (id) => ipcRenderer.invoke('chat:delete-session', id),
  renameSession: (id, name) => ipcRenderer.invoke('chat:rename-session', { id, name }),
  switchSession: (id) => ipcRenderer.invoke('chat:switch-session', id),
  reorderSessions: (ids) => ipcRenderer.invoke('chat:reorder-sessions', ids),
  chatStream: (payload, handlers) => {
    const onEvent = handlers && handlers.onEvent;
    const onDone = handlers && handlers.onDone;
    const onError = handlers && handlers.onError;
    const listener = (e, data) => {
      if (!data || !data.type) return;
      if (data.type === 'RUN_FINISHED') {
        if (onDone) onDone(data.result || {});
        // Keep listener alive for subsequent events (e.g. SESSION_RENAMED auto-rename), auto-cleanup after a few seconds
        setTimeout(() => ipcRenderer.removeListener('chat:event', listener), 5000);
      } else if (data.type === 'RUN_ERROR') {
        ipcRenderer.removeListener('chat:event', listener);
        if (onError) onError(data.error || '未知错误');
      } else if (onEvent) {
        onEvent(data);
      }
    };
    ipcRenderer.on('chat:event', listener);
    // 兼容旧调用: string；新调用: { text, html?, sessionId? }
    const body = typeof payload === 'string'
      ? { text: payload }
      : {
          text: String(payload && payload.text || ''),
          html: payload && payload.html ? String(payload.html) : '',
          sessionId: payload && payload.sessionId ? String(payload.sessionId) : '',
        };
    ipcRenderer.send('chat:stream', body);
  },
  chatReset: () => ipcRenderer.invoke('chat:reset'),
});
