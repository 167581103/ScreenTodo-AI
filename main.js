// screen-orb — 本地 agent
// 只负责渲染:建议弹窗 + 落地待办 + 工作台窗口。
// 网络逻辑(Screenpipe 抓取 + DeepSeek 判断)在 daemon.js,写 suggestions.jsonl,本进程监听它。
const { app, BrowserWindow, ipcMain, screen } = require('electron');
// globalShortcut / Tray / Menu / nativeImage 延迟引用:在某些 Electron 版本中,
// 其 getter 在模块加载阶段可能抛错,放在顶层的解构里会阻断整个 require。
let globalShortcut, Tray, Menu, nativeImage;
function _loadElectronUI() {
  ({ globalShortcut, Tray, Menu, nativeImage } = require('electron'));
}
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TODO_PATH = path.join(__dirname, CONFIG.monitor.todoFile);
const LOG_PATH = path.join(__dirname, 'orb_run.log');
const SUGG_FILE = path.join(__dirname, 'suggestions.jsonl');
const DECISIONS_FILE = path.join(__dirname, 'decisions.jsonl');
const PAUSE_FILE = path.join(__dirname, 'monitor.paused');
// todo_write.py 接入 Obsidian vault,替代裸写 captured_todos.md。可用环境变量覆盖以适配你自己的路径。
const TODO_WRITE = process.env.ORB_TODO_WRITE || '/Users/chancguo/WorkBuddy/Todo/scripts/todo_write.py';
const PYTHON = process.env.ORB_PYTHON || '/Users/chancguo/.workbuddy/binaries/python/versions/3.13.12/bin/python3';
// 工作台数据层(文件即真相,不引 SQLite)
const wsData = require('./workspace-data');
// 写入层 sink(存储可插拔,见 SINK_SPEC.md)
const { sinkAdd } = require('./sink.js');

let tray = null;
let suggWin = null;
let monitoring = true;
const shownIds = new Set();
let lastSize = 0;
let stats = { suggestions: 0, added: 0 };

// 建议弹窗队列:多条建议同时到达时,一次只显一个,处理完(dismiss)再弹下一个,
// 避免新弹窗 destroy 旧弹窗导致第一条被覆盖/丢失。
let suggestionQueue = [];
let showingSuggestion = false;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}

// ---------- 落地待办(通过写入层 sink,存储可插拔) ----------
function logDecision(id, decision) {
  try { fs.appendFileSync(DECISIONS_FILE, JSON.stringify({ id, decision, ts: new Date().toISOString() }) + '\n'); } catch (e) {}
}
async function addTodo(item) {
  if (item._id) logDecision(item._id, 'accepted');
  const todo = {
    title: item.title,
    reason: item.reason || '',
    context: item.context || '',
    raw: item.raw || '',
    apps: item.apps || [],
    time: new Date().toISOString(),
  };
  let ok = false;
  try { ok = await sinkAdd(todo); } catch (e) { log('sink 写入异常: ' + e.message); }
  if (ok) {
    stats.added++;
    log('已写入(sink): ' + item.title);
  } else {
    // 回退:sink 失败就写本地 captured_todos.md(不丢数据)
    const ts = new Date().toLocaleString('zh-CN');
    const line = `- [ ] ${item.title}  <!-- 来源:${(item.context || '').replace(/\n/g, ' ').slice(0, 60)} | ${ts} -->\n`;
    try {
      if (!fs.existsSync(TODO_PATH)) fs.writeFileSync(TODO_PATH, '# 屏幕捕获的待办(回退)\n\n> sink 不可用时的本地回退。\n\n');
      fs.appendFileSync(TODO_PATH, line);
      stats.added++;
      log('sink 失败,回退写入本地: ' + item.title);
    } catch (e) { log('回退写入也失败: ' + e.message); }
  }
  updateTray();
}

// ---------- 状态栏图标(Tray) ----------
function createTray() {
  _loadElectronUI();
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  const sized = icon.resize({ width: 22, height: 22 });
  sized.setTemplateImage(true);
  tray = new Tray(sized);
  tray.setToolTip('Claw · 就绪');
  tray.on('click', () => { tray.popUpContextMenu(buildTrayMenu()); });
  log('状态栏图标已创建');
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: `本次 ${stats.suggestions} 建议 · ${stats.added} 添加`, enabled: false },
    { type: 'separator' },
    { label: '打开工作台', click: () => openWorkspace() },
    { type: 'separator' },
    { label: monitoring ? '暂停监听' : '开启监听', click: () => toggleMonitor() },
    { type: 'separator' },
    { label: '退出', role: 'quit' },
  ]);
}

function toggleMonitor() {
  monitoring = !monitoring;
  if (monitoring) { try { fs.unlinkSync(PAUSE_FILE); } catch (e) {} }
  else { try { fs.writeFileSync(PAUSE_FILE, '1'); } catch (e) {} }
  log('监听: ' + (monitoring ? '开启' : '暂停'));
  updateTray();
}

function updateTray() {
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(`Claw · ${monitoring ? '监听中' : '已暂停'} · ${stats.suggestions}建议 · ${stats.added}添加`);
  }
}

// ---------- 建议弹窗(队列) ----------
// 入队:多条建议同时到达时先排队,由 pumpSuggestion 逐个弹出
function showSuggestion(item) {
  suggestionQueue.push(item);
  pumpSuggestion();
}

// 取队列下一个:若正在显示则等待,队列空则退出
function pumpSuggestion() {
  if (showingSuggestion) return;
  if (suggestionQueue.length === 0) { showingSuggestion = false; return; }
  const item = suggestionQueue.shift();
  showingSuggestion = true;
  openSuggestionWindow(item);
}

// 关闭当前弹窗并弹下一个(点 Add/Ignore/20s 自动忽略 都走这里)
function dismissSuggestion() {
  if (suggWin && !suggWin.isDestroyed()) suggWin.destroy();
  suggWin = null;
  showingSuggestion = false;
  // 稍延迟再泵下一个:避免同一瞬间重建窗口的竞态(Electron 销毁回调未完成)
  setTimeout(pumpSuggestion, 60);
}

function openSuggestionWindow(item) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  if (suggWin && !suggWin.isDestroyed()) suggWin.destroy();
  suggWin = new BrowserWindow({
    width: 380, height: 160, x: width - 404, y: height - 184,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, hasShadow: false, skipTaskbar: true,
    show: false, focusable: true, // 可聚焦:点击落在弹窗自身,不穿透到下方窗口(否则会误激活工作台)
    acceptFirstMouse: true, // 首次点击即生效,无需先激活窗口
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  suggWin.setAlwaysOnTop(true, 'floating');
  suggWin.loadFile('suggestion.html');
  suggWin.webContents.once('did-finish-load', () => {
    suggWin.webContents.send('suggestion', item);
    // 按内容动态定高:长标题/正文/原文完整展开,不裁切;超出 560 上限再内部滚动
    setTimeout(() => {
      suggWin.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)').then((h) => {
        const H = Math.max(160, Math.min(560, h || 160));
        suggWin.setBounds({ width: 380, height: H, x: width - 380 - 24, y: height - H - 24 });
        suggWin.showInactive(); // 显示但不抢焦点;点击按钮仍可用(IPC),只是焦点留在你正在用的窗口
      }).catch(() => suggWin.showInactive());
    }, 60);
  });
}

// ---------- 监听 suggestions 文件(daemon 写入) ----------
function processSuggestions() {
  try {
    if (!fs.existsSync(SUGG_FILE)) return;
    const size = fs.statSync(SUGG_FILE).size;
    if (size < lastSize) lastSize = 0;       // 文件被清空/截断,从头读
    if (size === lastSize) return;
    const fd = fs.openSync(SUGG_FILE, 'r');
    const buf = Buffer.alloc(size - lastSize);
    fs.readSync(fd, buf, 0, size - lastSize, lastSize);
    fs.closeSync(fd);
    lastSize = size;
    for (const l of buf.toString('utf8').split('\n')) {
      if (!l.trim()) continue;
      let rec; try { rec = JSON.parse(l); } catch (e) { continue; }
      if (!rec.id || shownIds.has(rec.id)) continue;
      shownIds.add(rec.id);
      stats.suggestions++;
      showSuggestion({ ...rec.item, _id: rec.id });
    }
  } catch (e) {
    log('读建议错误: ' + e.message);
  }
}

function startWatcher() {
  // 启动即把所有历史 id 记入 shownIds + lastSize 设到文件尾:
  // 双保险,即使文件被外部重写(大小骤变)也不会重弹历史(避免一堆旧弹窗刷屏)
  if (fs.existsSync(SUGG_FILE)) {
    try {
      for (const l of fs.readFileSync(SUGG_FILE, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const rec = JSON.parse(l); if (rec.id) shownIds.add(rec.id); } catch (e) {}
      }
      lastSize = fs.statSync(SUGG_FILE).size;
    } catch (e) {}
  }
  processSuggestions();
  try { fs.watch(SUGG_FILE, () => processSuggestions()); } catch (e) {}
  setInterval(processSuggestions, 2000); // 兜底轮询,防某些 fs 不触发 watch
}

// ---------- IPC ----------
ipcMain.on('toggle-monitor', () => {
  toggleMonitor();
});
ipcMain.on('add-todo', (e, item) => { addTodo(item); dismissSuggestion(); });
ipcMain.on('ignore-todo', (e, item) => { if (item && item._id) logDecision(item._id, 'ignored'); dismissSuggestion(); });
ipcMain.on('quit-app', () => app.quit());
ipcMain.handle('get-state', () => ({ monitoring, stats }));

// ---------- 工作台 IPC ----------
ipcMain.on('open-workspace', () => openWorkspace());
ipcMain.handle('workspace:getRecall', () => wsData.getRecall());
ipcMain.handle('workspace:getMeetings', () => wsData.getMeetings());
ipcMain.handle('workspace:getRoutines', () => wsData.getRoutines());
ipcMain.handle('workspace:getTimeline', async () => await wsData.getTimeline());
ipcMain.handle('workspace:search', (e, q) => wsData.search(q));

// ---------- 工作台窗口 ----------
let workspaceWin = null;
function openWorkspace() {
  if (workspaceWin && !workspaceWin.isDestroyed()) { workspaceWin.focus(); return; }
  workspaceWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 880, minHeight: 580,
    backgroundColor: '#F4F1EA', show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#F4F1EA', symbolColor: '#6B8472', height: 38 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  workspaceWin.loadFile('workspace.html');
  workspaceWin.once('ready-to-show', () => workspaceWin.show());
  // 主进程注入数据数组到 window.__RECALL__,由 workspace.html 渲染(tab/详情/点击都在渲染层)
  // 只在数据实际变化时才推送 → 避免每 5s 全量重渲染导致列表闪烁
  let lastPayloadHash = null;
  const pushData = (force) => {
    if (!workspaceWin || workspaceWin.isDestroyed()) return;
    try {
      const items = wsData.getRecall();
      const payload = JSON.stringify(items);
      let h = 0; for (let i = 0; i < payload.length; i++) h = (h * 31 + payload.charCodeAt(i)) | 0;
      if (!force && h === lastPayloadHash) return; // 数据没变 → 不推送,不重渲染
      lastPayloadHash = h;
      workspaceWin.webContents.executeJavaScript(
        `window.__RECALL__ = ${payload}; if(window.renderRecall) window.renderRecall();`
      );
    } catch (e) { log('注入失败: ' + e.message); }
  };
  workspaceWin.webContents.once('did-finish-load', () => { pushData(true); log('工作台数据已注入'); startWorkspaceRefresh(pushData); });
  workspaceWin.on('closed', () => { workspaceWin = null; clearInterval(workspaceRefresh); });
  log('打开工作台窗口');
}

// 工作台实时刷新:每 5s 重注入数据(匹配 daemon tick 间隔)
let workspaceRefresh = null;
function startWorkspaceRefresh(pushData) {
  if (workspaceRefresh) return;
  workspaceRefresh = setInterval(() => {
    if (!workspaceWin || workspaceWin.isDestroyed()) { clearInterval(workspaceRefresh); workspaceRefresh = null; return; }
    pushData();
  }, 5000);
}

// ---------- 启动 ----------
app.whenReady().then(() => {
  _loadElectronUI();
  log('=== screen-orb 启动 ===');
  createTray();
  startWatcher();
  openWorkspace(); // 启动即开工作台主窗口
  try { globalShortcut.register('CommandOrControl+Shift+W', () => openWorkspace()); } catch (e) {}
});
app.on('window-all-closed', () => {}); // 状态栏常驻,不退出
