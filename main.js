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
const TODO_WRITE = process.env.ORB_TODO_WRITE || '/Users/apple/WorkBuddy/Todo/scripts/todo_write.py';
const PYTHON = process.env.ORB_PYTHON || '/Users/apple/.workbuddy/binaries/python/versions/3.13.12/bin/python3';
// 工作台数据层(文件即真相,不引 SQLite)
const wsData = require('./workspace-data');
// 工具可配置目录(内置 / 本地 / MCP / 官方连接器 四类)
const toolCatalog = require('./tools-catalog');
// 写入层 sink(存储可插拔,见 SINK_SPEC.md)
const { sinkAdd } = require('./sink.js');

// ── 对话 Agent(前台入口)——与后台 daemon 同一 agent.js 内核,工具集不同 ──
// 屏幕上下文工具:向本机 Screenpipe 查最近 OCR 文本(与 daemon 的 get_more_context 同源)
async function screenRecent(app) {
  try {
    const url = `${(CONFIG.screenpipe.apiBase || 'http://localhost:3030').replace(/\/$/, '')}/search?limit=40&content_type=ocr`;
    // Screenpipe API 需 Bearer 鉴权(与 daemon fetchRaw 一致)
    const spKey = (CONFIG.screenpipe && CONFIG.screenpipe.apiKey) || '';
    const headers = spKey ? { Authorization: `Bearer ${spKey}` } : {};
    const r = await fetch(url, { headers }); const d = await r.json();
    const seen = new Set(); const lines = [];
    for (const it of (d.data || [])) {
      const c = it.content || {}; const a = c.app_name || '';
      if (app && !a.includes(app)) continue;
      const txt = (c.text || '').trim(); if (!txt) continue;
      const key = txt.replace(/\s+/g, '').slice(0, 120); if (seen.has(key)) continue; seen.add(key);
      lines.push(`[${a || '?'}] ${txt.slice(-400)}`);
      if (lines.length >= 15) break;
    }
    return lines.join('\n').slice(0, 3500) || '(未取到屏幕内容)';
  } catch (e) { return '屏幕上下文获取失败: ' + e.message; }
}
const chatTools = {
  get_more_context: {
    def: { type: 'function', function: { name: 'get_more_context', description: '拉取某来源(app)最近的屏幕 OCR 内容,用于回顾/补全上下文。', parameters: { type: 'object', properties: { app: { type: 'string', description: '来源应用名,留空取全部' } } } } },
    run: async (a) => screenRecent(a && a.app),
  },
  search_captured: {
    def: { type: 'function', function: { name: 'search_captured', description: '在已捕获的工作记忆(待办/建议)里按关键词检索。查"今天/多少/全部待办"这类列表统计,请改用 list_todos。', parameters: { type: 'object', properties: { query: { type: 'string', description: '单个关键词最佳;多个词会做 OR 匹配' } }, required: ['query'] } } },
    run: async (a) => {
      try {
        const q = (a.query || '').trim();
        const words = q.split(/\s+/).filter(Boolean);
        // 多词做 OR 合并去重(避免多词 AND 命中率过低返回空)
        let rs = [];
        if (words.length <= 1) rs = wsData.search ? wsData.search(q) : [];
        else {
          const seen = new Set();
          for (const w of words) for (const r of (wsData.search ? wsData.search(w) : [])) {
            const k = r.title || JSON.stringify(r); if (!seen.has(k)) { seen.add(k); rs.push(r); }
          }
        }
        return JSON.stringify((rs || []).slice(0, 15)).slice(0, 3000) || '[]';
      } catch (e) { return '检索失败: ' + e.message; }
    },
  },
  list_todos: {
    def: { type: 'function', function: { name: 'list_todos', description: '列出已捕获的待办/记忆条目,用于回答"今天有哪些待办/一共多少/最近记了什么"这类列表与统计问题。', parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['today', 'all', 'pending'], description: 'today=今天捕获的;pending=待处理;all=全部(默认最近若干条)' } } } } },
    run: async (a) => {
      try {
        const all = wsData.getRecall ? wsData.getRecall() : [];
        const scope = (a && a.scope) || 'all';
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        let list = all;
        if (scope === 'today') list = all.filter(x => x.time && x.time >= startOfDay.getTime());
        else if (scope === 'pending') list = all.filter(x => !x.status);
        const brief = list.slice(0, 40).map(x => ({ title: x.title, status: x.status || 'pending', time: x.time ? new Date(x.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '' }));
        return JSON.stringify({ scope, total: list.length, items: brief }).slice(0, 3500);
      } catch (e) { return '列举失败: ' + e.message; }
    },
  },
  save_todo: {
    def: { type: 'function', function: { name: 'save_todo', description: '把一条待办写入用户的 todo 系统(vault)。确认是用户想记的事再调用。', parameters: { type: 'object', properties: { title: { type: 'string', description: '简短待办标题' }, note: { type: 'string', description: '补充说明/来源(可选)' } }, required: ['title'] } } },
    run: async (a) => {
      try { const ok = await sinkAdd({ title: a.title, context: a.note || '', reason: '对话中记录', time: new Date().toISOString() }); return ok ? ('已写入: ' + a.title) : '写入失败'; }
      catch (e) { return '写入失败: ' + e.message; }
    },
  },
};
const chatAgent = require('./agent.js')(CONFIG, log, chatTools);

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

// ---------- 设置:读写 config.filter(黑/白名单) ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
ipcMain.handle('settings:getFilter', () => {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const f = c.filter || {};
    return { denyApps: f.denyApps || [], allowApps: f.allowApps || [] };
  } catch (e) { return { denyApps: [], allowApps: [] }; }
});
ipcMain.on('settings:setFilter', (e, f) => {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    c.filter = c.filter || {};
    if (Array.isArray(f.denyApps)) c.filter.denyApps = f.denyApps;
    if (Array.isArray(f.allowApps)) c.filter.allowApps = f.allowApps;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
    log('已更新过滤名单: deny=' + JSON.stringify(c.filter.denyApps) + ' allow=' + JSON.stringify(c.filter.allowApps));
  } catch (err) { log('写过滤名单失败: ' + err.message); }
});

// ---------- 工具可见性:查看 Agent 可访问工具 + 配置来源开关 ----------
// 读取实时 config.tools.sources,回填每类 enabled。读文件而非缓存 CONFIG,保证开关即时反映。
ipcMain.handle('tools:list', () => {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { categories: toolCatalog.getCatalog(c), defaults: toolCatalog.DEFAULT_ENABLED };
  } catch (e) {
    return { categories: toolCatalog.getCatalog({}), defaults: toolCatalog.DEFAULT_ENABLED };
  }
});
ipcMain.on('tools:setSources', (e, sources) => {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    c.tools = c.tools || {};
    c.tools.sources = toolCatalog.normalizeSources(sources);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
    const parts = Object.keys(c.tools.sources).map((k) => k + '=' + (c.tools.sources[k].enabled ? '开' : '关'));
    log('已更新工具来源开关: ' + parts.join(' '));
  } catch (err) { log('写工具来源开关失败: ' + err.message); }
});

// ---------- 获取当前运行进程列表(供设置页白/黑名单选择)----------
const { execSync } = require('child_process');
ipcMain.handle('settings:running-processes', () => {
  try {
    const out = execSync('ps -eo comm | sed 1d | sort -u', { encoding: 'utf8', timeout: 3000 });
    return out.trim().split('\n').filter(Boolean);
  } catch (e) { log('获取进程列表失败: ' + e.message); return []; }
});

// ---------- 对话 Agent(工作台内嵌面板)—— 多会话管理 ----------
const SESSIONS_PATH = path.join(__dirname, 'sessions.json');
let _sessions = null;
function loadSessions() {
  if (!_sessions) {
    try { _sessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); }
    catch (e) { _sessions = { active: null, list: [] }; }
  }
  return _sessions;
}
function saveSessions() { fs.writeFileSync(SESSIONS_PATH, JSON.stringify(_sessions, null, 2) + '\n'); }
function getActive() {
  const s = loadSessions();
  if (!s.active || !s.list.find(x => x.id === s.active)) {
    // 没有活跃会话时自动创建默认
    const id = 'sess-' + Date.now().toString(36);
    const def = { id, name: '默认对话', createdAt: new Date().toISOString(), messages: [] };
    s.list.push(def); s.active = id; saveSessions();
    return def;
  }
  return s.list.find(x => x.id === s.active);
}

ipcMain.handle('chat:list-sessions', () => {
  const s = loadSessions();
  return { active: s.active, list: s.list.map(x => ({ id: x.id, name: x.name, createdAt: x.createdAt, msgCount: (x.messages||[]).length })) };
});
ipcMain.handle('chat:get-session', (e, id) => {
  const s = loadSessions();
  return s.list.find(x => x.id === id) || null;
});
ipcMain.handle('chat:create-session', () => {
  const s = loadSessions();
  const id = 'sess-' + Date.now().toString(36);
  const ses = { id, name: '新的对话', createdAt: new Date().toISOString(), messages: [] };
  s.list.push(ses); s.active = id; saveSessions();
  return { active: s.active, list: s.list.map(x => ({ id: x.id, name: x.name, createdAt: x.createdAt, msgCount: (x.messages||[]).length })) };
});
ipcMain.handle('chat:delete-session', (e, id) => {
  const s = loadSessions();
  const idx = s.list.findIndex(x => x.id === id);
  if (idx < 0) return s;
  s.list.splice(idx, 1);
  if (s.active === id) s.active = s.list.length ? s.list[0].id : null;
  saveSessions();
  return { active: s.active, list: s.list.map(x => ({ id: x.id, name: x.name, createdAt: x.createdAt, msgCount: (x.messages||[]).length })) };
});
ipcMain.handle('chat:rename-session', (e, { id, name }) => {
  const s = loadSessions();
  const ses = s.list.find(x => x.id === id);
  if (ses) { ses.name = String(name||'').trim() || ses.name; saveSessions(); }
  return ses ? { id: ses.id, name: ses.name } : null;
});
ipcMain.handle('chat:switch-session', (e, id) => {
  const s = loadSessions();
  if (s.list.find(x => x.id === id)) { s.active = id; saveSessions(); return getActive(); }
  return getActive();
});
ipcMain.handle('chat:reorder-sessions', (e, ids) => {
  const s = loadSessions();
  s.list = ids.map(id => s.list.find(x => x.id === id)).filter(Boolean);
  saveSessions();
  return { ok: true };
});

// 流式对话:消息写入当前活跃会话
ipcMain.on('chat:stream', async (e, text) => {
  const sender = e.sender;
  const toolsThisRun = [];
  const emit = (type, payload = {}) => {
    // 截获工具调用,持久化到会话展示历史(仅记工具名)
    if (type === 'TOOL_CALL_END' && payload.toolName) toolsThisRun.push(String(payload.toolName));
    try { sender.send('chat:event', { type, ...payload }); } catch (_) {}
  };
  const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('响应超时')), 50000));
  const ses = getActive();
  // 传给 LLM 的 history 只保留 user/assistant(tool 行是展示用,混入会破坏 API 调用配对)
  let history = (ses.messages || []).filter(m => m.role === 'user' || m.role === 'assistant');
  try {
    const r = await Promise.race([chatAgent.runOnChat(String(text || ''), history, emit), guard]);
    const reply = r && r.reply ? r.reply
      : (r && r.suggest && r.items && r.items.length) ? ('我记下了:' + r.items.map(i => i.title).join('、'))
      : (r && r._reply) ? r._reply
      : (typeof r === 'string' ? r : (r && r.text) || '(已处理)');
    ses.messages.push({ role: 'user', content: String(text || '') });
    for (const t of toolsThisRun) ses.messages.push({ role: 'tool', content: t });
    ses.messages.push({ role: 'assistant', content: reply });
    if (ses.messages.length > 60) ses.messages = ses.messages.slice(-60);
    saveSessions();
    emit('RUN_FINISHED', { result: { reply } });
  } catch (err) {
    log('chat 失败: ' + err.message);
    emit('RUN_ERROR', { error: '出错了: ' + err.message });
  }
});
ipcMain.handle('chat:reset', () => {
  const ses = getActive();
  ses.messages = [];
  saveSessions();
  return { ok: true };
});

// 可引用文件列表:工作目录下 .md/.txt/.jsonl,排除非用户文件
ipcMain.handle('chat:list-files', () => {
  try {
    const f = fs.readdirSync(__dirname);
    const skip = /^(\.git|node_modules|\.screenpipe|\.workbuddy|assets|prompts|sinks|orb\.html|suggestion\.html|tray-icon\.png|package-lock\.json|decisions\.jsonl|suggestions\.jsonl|sessions\.json|\.gitignore|config\.json)$/;
    const out = [];
    for (const fn of f) {
      if (skip.test(fn)) continue;
      const fp = path.join(__dirname, fn);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (st.isFile() && /\.(md|txt|jsonl)$/i.test(fn)) out.push(fn);
    }
    return out;
  } catch (e) { return []; }
});

// Markdown 渲染在主进程(Node,可安全 require;preload 在 sandbox 下不能 require 第三方)。
// dompurify 需 DOM,主进程无 DOM → 用 marked 解析 + 轻量 sanitize(去 script/on* /javascript:)。
let _marked = null;
function renderMarkdownMain(md) {
  try {
    if (!_marked) _marked = require('marked');
    let html = _marked.parse(String(md || ''), { breaks: true, gfm: true });
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript:/gi, '');
    return html;
  } catch (e) {
    // 兜底:纯文本转义 + 换行
    return String(md || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
  }
}
ipcMain.handle('chat:renderMarkdown', (e, md) => renderMarkdownMain(md));

// ---------- 工作台窗口 ----------
let workspaceWin = null;
function openWorkspace() {
  if (workspaceWin && !workspaceWin.isDestroyed()) { workspaceWin.focus(); return; }
  // 外观:config.appearance.theme = auto/dark/light → 决定窗口初始底色 + nativeTheme
  const theme = (CONFIG.appearance && CONFIG.appearance.theme) || 'auto';
  try { const { nativeTheme } = require('electron'); if (theme !== 'auto') nativeTheme.themeSource = theme; } catch (e) {}
  const dark = theme === 'dark' || (theme === 'auto' && (() => { try { return require('electron').nativeTheme.shouldUseDarkColors; } catch (e) { return false; } })());
  const winBg = dark ? '#151619' : '#FBFBFC';
  // 沉浸式:仅隐藏原生标题栏,不画 38px overlay 控制条 → 交通灯直接浮在内容上方
  workspaceWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 880, minHeight: 580,
    backgroundColor: winBg, show: false,
    titleBarStyle: 'hidden',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  workspaceWin.loadFile('workspace.html');
  workspaceWin.once('ready-to-show', () => workspaceWin.show());
  if (process.env.ORB_DEVTOOLS) workspaceWin.webContents.openDevTools({ mode: 'detach' });
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
