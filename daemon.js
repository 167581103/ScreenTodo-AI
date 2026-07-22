// orb-daemon — 独立 Node 守护进程(网络逻辑)
// 多轮对话模式:启动先把「当前屏幕最近内容」作为首轮上下文(baseline)喂给模型,
// 之后每轮只把「屏幕增量」作为新 user message 追加。
// 第 N+1 轮请求的整个前缀(历史对话)都被 DeepSeek prefix cache 命中,只有本轮增量 miss → 命中率趋近 98%。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sinkFind } = require('./sink.js'); // 写入层去重:查 todo 是否已存在于配置的存储
const { sanitizeFrame } = require('./sanitize.js'); // 输入预处理:剥离导航态/UI chrome 噪声
const { segmentFrame } = require('./segment.js'); // 几何窗口分割:按坐标把糊锅多窗口切开

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SUGG_FILE = path.join(__dirname, 'suggestions.jsonl');
const PAUSE_FILE = path.join(__dirname, 'monitor.paused');
const LOG_PATH = path.join(__dirname, 'daemon.log');

function log(m) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}

// 语义层(核心算法)独立在 judge.js。daemon 只负责编排:取帧→预处理→[judge]→去重→写入。
// 判读 Agent 内核(有工具、有界 ReAct)。工具 get_more_context 让它在指代/上下文不全时自主补帧再判。
const createAgent = require('./agent.js');
// 工具:拉某来源(app)最近更多帧的文本,用于补全"这个/它"等指代 & 跨帧前文。
const agentTools = {
  get_more_context: {
    def: {
      type: 'function',
      function: {
        name: 'get_more_context',
        description: '当屏幕文本里出现指代词(这个/它/上面那条)但看不到被指代对象,或消息像是某对话的片段而缺前文时,调用此工具拉取该来源最近的更多屏幕内容,以补全上下文。',
        parameters: {
          type: 'object',
          properties: {
            app: { type: 'string', description: '来源应用名,如"企业微信"。留空则取全部来源最近内容。' },
            hint: { type: 'string', description: '你想找什么(如"这个指代的原文/被引用的消息"),便于聚焦。' },
          },
        },
      },
    },
    run: async (args) => {
      const raw = await fetchRaw(40); // 拉最近 40 帧(已过滤+sanitize)
      let picked = raw;
      if (args && args.app) picked = raw.filter((f) => (f.app || '').includes(args.app));
      if (!picked.length) picked = raw; // 该 app 没匹配到,退回全部
      // 时间正序、去重、截断,拼成可读上下文
      const seen = new Set(); const lines = [];
      for (const f of picked.slice(0, 20)) {
        const key = f.txt.replace(/\s+/g, '').slice(0, 120);
        if (seen.has(key)) continue; seen.add(key);
        lines.push(`[${f.app || '?'}] ${f.txt.slice(-500)}`);
      }
      const out = lines.join('\n').slice(0, 3500);
      return out || '(未取到更多上下文)';
    },
  },
};
const agent = createAgent(CONFIG, log, agentTools);
const judge = (screenText) => agent.runOnScreen(screenText);

// 增量游标:用帧时间戳(ISO)而非 frame_id。Screenpipe 搜索结果的 frame_id 不完全保序(同毫秒多窗口帧会乱序),
// 用 frame_id 当游标会被乱序推高、导致真实新帧被永久丢弃(表现为"无新增屏幕,跳过")。改用 start_time 时间戳游标根治。
let lastTs = null;
let stats = { rounds: 0, compacts: 0 };
const titleSeen = new Set(); // 已建议过的标题,避免重复弹窗

// —— 模糊去重:宁滥勿缺模式下,模型可能把同一需求换种说法重复建议,需按"近似"拦截 ——
function normTitle(s) { return (s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }
function lcsLen(a, b) {
  if (!a || !b) return 0;
  const n = a.length, m = b.length;
  let best = 0; const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = tmp;
    }
  }
  return best;
}
function isDupTitle(title) {
  const n = normTitle(title);
  if (!n) return false;
  for (const s of titleSeen) {
    const m = normTitle(s);
    if (n === m) return true;
    if (n.includes(m) || m.includes(n)) return true; // 一方包含另一方
    if (Math.min(n.length, m.length) >= 8 && lcsLen(n, m) >= 8) return true; // 长公共子串=同一需求不同表述
  }
  return false;
}

// 拉取最近 N 条 OCR 帧,返回 {fid, app, txt, ts} 数组(已按配置过滤 app)
// sinceTs: 若提供,只取该时间戳之后的帧(Screenpipe start_time,ISO 本地时区),用于增量游标
async function fetchRaw(limit, sinceTs) {
  let url = `${CONFIG.screenpipe.apiBase.replace(/\/$/, '')}/search?limit=${limit}&content_type=ocr`;
  if (sinceTs) url += `&start_time=${encodeURIComponent(sinceTs)}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const d = await r.json();
    const items = d.data || [];
    // 白/黑名单:每次实时从 config.json 读取 → 设置页改动即时生效,无需重启 daemon。
    // allowApps 非空 → 只放行名单内;denyApps → 一律拦截。兼容旧 monitor.ignoreApps。
    let flt = CONFIG.filter || {};
    try { flt = (JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).filter) || flt; } catch (e) {}
    const denyApps = flt.denyApps || CONFIG.monitor.ignoreApps || [];
    const allowApps = flt.allowApps || [];
    const out = [];
    for (const it of items) {
      const c = it.content || {};
      const app = c.app_name || '';
      const rawTxt = (c.text || '').trim();
      if (allowApps.length && !allowApps.includes(app)) continue; // 白名单模式
      if (denyApps.includes(app)) continue;                        // 黑名单
      // 行级剥离 chrome / 通用噪声,保留同屏其它窗口内容
      const txt = sanitizeFrame(rawTxt);
      if (!txt) continue;
      out.push({ fid: c.frame_id || 0, app, txt, ts: c.timestamp || null });
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

// 批量从本地 Screenpipe DB 取 frame_id → text_json(search API 不返回坐标块,只能查库)。
// 用于几何窗口分割。查不到/出错则返回空 map,分割自动退回拼平文本。
const SP_DB = (() => {
  try {
    const base = (CONFIG.screenpipe.dataDir) || path.join(path.dirname(__dirname), '.screenpipe');
    // 常见位置:项目上级 .screenpipe/db.sqlite;也兼容 Todo/.screenpipe
    const cands = [
      path.join('/Users/chancguo/WorkBuddy/Todo/.screenpipe', 'db.sqlite'),
      path.join(base, 'db.sqlite'),
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
  } catch (e) {}
  return null;
})();
function fetchTextJson(frameIds) {
  const map = {};
  if (!SP_DB || !frameIds.length) return map;
  try {
    const ids = frameIds.filter(Number.isFinite).join(',');
    if (!ids) return map;
    const out = execFileSync('sqlite3', ['-json', SP_DB,
      `SELECT frame_id, text_json FROM ocr_text WHERE frame_id IN (${ids}) AND text_json IS NOT NULL AND text_json!='';`],
      { maxBuffer: 64 * 1024 * 1024, timeout: 4000 }).toString();
    for (const row of JSON.parse(out || '[]')) map[row.frame_id] = row.text_json;
  } catch (e) {}
  return map;
}

// 仅把 lastTs 设到当前最新帧时间,避免首轮把历史全当增量(兜底用)
async function primeLastTs() {
  try {
    const raw = await fetchRaw(1);
    if (raw[0] && raw[0].ts) lastTs = raw[0].ts;
    log('[prime] lastTs=' + lastTs);
  } catch (e) { log('[prime] 失败: ' + e.message); }
}

// 启动即把「当前屏幕最近内容」作为首轮上下文喂给模型(baseline seed)
// 这样启动那一刻已停在屏幕上的隐藏需求也能被检测到,而不是只能等到屏幕变化。
// 注意: 必须走 judgeWithCompletion(与 tick 同套), 否则单次 judge 会放过"可能需关注"这类无锚点弱信号误捕。
// 启动即判一次当前屏幕(baseline seed):复用滑窗 fetchContext,避免启动时发超大 prompt。
async function seedBaseline() {
  try {
    const inc = await fetchContext();
    if (inc.lines.length) {
      const screenText = inc.lines.join('\n');
      lastWinHash = cheapHash(screenText); // 记录基线哈希,避免首个 tick 立刻重判同一屏
      const j = await judge(screenText);
      log('[baseline] 载入屏幕 ' + inc.lines.length + ' 帧 ' + screenText.length + '字 | suggest=' + j.suggest + (j.suggest ? ' ' + (j.items ? j.items.map(i => i.title).join('; ') : j.title) : ''));
      await handleSuggest(j, { apps: inc.apps, raw: screenText.slice(0, 2000) });
    } else {
      log('[baseline] 无可见屏幕内容,跳过');
    }
  } catch (e) {
    log('[baseline] 失败: ' + e.message + ' → 仅做 prime');
    await primeLastTs();
  }
}

// 滑动窗口上下文:总是取「最近 K 帧」(不管新旧),相邻两次有重叠 → 跨帧上下文完整,
// 且封顶 token 有界。配合内容哈希静止跳过(屏幕没变不调 API),避免重复烧钱。
// lastWinHash: 上次送判的窗口内容哈希,相同则跳过(屏幕静止)。
let lastWinHash = null;
function cheapHash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

async function fetchContext() {
  const K = CONFIG.monitor.winFrames || 6;         // 滑窗帧数:近 K 帧
  const PERFRAME = CONFIG.monitor.winPerFrame || 900; // 每帧取尾部字符数
  const MAXC = CONFIG.monitor.winMaxChars || 4500;  // 窗口总字符硬上限(≈3k token)
  // 拉最近若干帧(取比 K 略多,过滤后凑够 K)
  const raw = await fetchRaw(Math.max(K * 3, 20));
  const lines = [];
  const apps = new Set();
  let maxTs = lastTs;
  // raw 是按时间倒序(最新在前),取前 K 个有文本的帧,再反转成时间正序
  const picked = [];
  for (const f of raw) {
    if (f.ts && (!maxTs || f.ts > maxTs)) maxTs = f.ts;
    if (f.txt && picked.length < K) { picked.push(f); if (f.app) apps.add(f.app); }
  }
  picked.reverse(); // 时间正序:旧→新,符合阅读顺序
  // 几何窗口分割:批量取这些帧的 text_json,能切开的帧按区域分别成行(区域间空间独立)。
  // 关键:滑窗内多帧常含相同的侧边栏/导航区 → 按内容归一化去重,避免同一区域堆叠 N 次撑爆窗口。
  const tjMap = fetchTextJson(picked.map(f => f.fid));
  const seenRegion = new Set();
  const normRegion = (s) => s.replace(/\s+/g, '').slice(0, 200); // 归一化取指纹(前 200 字)
  const MAX_REGIONS = CONFIG.monitor.maxRegions || 12;           // 单次窗口区域数上限
  for (const f of picked) {
    const regions = tjMap[f.fid] ? segmentFrame(tjMap[f.fid]) : null;
    if (regions && regions.length >= 2) {
      for (const rg of regions) {
        const clean = sanitizeFrame(rg);
        if (!clean) continue;
        const fp = normRegion(clean);
        if (fp.length < 8 || seenRegion.has(fp)) continue; // 跨帧重复区域(如侧边栏)只留一次
        seenRegion.add(fp);
        lines.push(`[${f.app}·区域] ${clean.slice(-PERFRAME)}`);
      }
    } else {
      const clean = f.txt;
      const fp = normRegion(clean);
      if (seenRegion.has(fp)) continue;
      seenRegion.add(fp);
      lines.push(`[${f.app}] ${clean.slice(-PERFRAME)}`);
    }
  }
  // 区域数封顶:保留最新(尾部)的 N 个,防止碎片撑爆
  if (lines.length > MAX_REGIONS) lines.splice(0, lines.length - MAX_REGIONS);
  lastTs = maxTs;
  // 总额字符硬上限:丢最旧行、保最新行
  let tot = lines.reduce((s, l) => s + l.length, 0);
  let truncated = false;
  while (lines.length > 1 && tot > MAXC) { tot -= lines.shift().length; truncated = true; }
  return { lines, apps: [...apps], truncated };
}

async function handleSuggest(j, meta) {
  let items = [];
  if (Array.isArray(j.items)) items = j.items;
  else if (j.suggest && j.title) items = [j];
  if (!j.suggest || !items.length) return;
  for (const it of items) {
    const key = (it.title || '').trim();
    if (!key) continue;
    // 去重两层:① 本会话内存(titleSeen,免费快) ② 写入层存储(sinkFind,查 vault/Notion 等已有)
    if (isDupTitle(key)) { log('[dedup] 本会话去重跳过: ' + key); continue; }
    let existsInStore = false;
    try { existsInStore = await sinkFind({ title: key }); } catch (e) {}
    if (existsInStore) { log('[dedup] 存储已有,跳过: ' + key); titleSeen.add(key); continue; }
    titleSeen.add(key);
    const rec = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      item: it,
      apps: meta?.apps || [],
      raw: meta?.raw || '',
      ts: new Date().toISOString(),
    };
    fs.appendFileSync(SUGG_FILE, JSON.stringify(rec) + '\n');
    log('发现隐藏需求: ' + it.title + ' | ' + (it.reason || ''));
  }
}

async function tick() {
  if (fs.existsSync(PAUSE_FILE)) return;
  const savedLastTs = lastTs;
  try {
    const inc = await fetchContext();
    if (!inc.lines.length) { log('[tick] 无屏幕内容,跳过'); return; }
    const screenText = inc.lines.join('\n');
    // 静止跳过:窗口内容和上次完全一致 → 屏幕没动,不调 API(省钱关键)
    const h = cheapHash(screenText);
    if (h === lastWinHash) { return; } // 静默跳过,不刷日志
    lastWinHash = h;
    stats.rounds = (stats.rounds || 0) + 1;
    log(`[tick #${stats.rounds}] 窗口 ${inc.lines.length} 帧 ${screenText.length}字` + (inc.truncated ? ' [截断]' : '') + (inc.apps.includes('企业微信') ? ' [群聊]' : ''));
    const j = await judge(screenText);
    log('[judge] suggest=' + j.suggest + (j.suggest ? ' ' + (j.items ? j.items.map(i => i.title).join('; ') : j.title) : ''));
    await handleSuggest(j, { apps: inc.apps, raw: screenText.slice(0, 2000) });
  } catch (e) {
    lastTs = savedLastTs;
    log('tick 错误: ' + e.message);
  }
}

// Obsidian vault 日常/ 目录:接入真正的 todo 文件系统做机械去重(可环境变量覆盖)
const VAULT_DAILY = process.env.ORB_VAULT_DAILY || '/Users/chancguo/Todo/todo/日常';

// 扫描 vault 所有任务标题(- [ ]/- [x]/- [-]),加入 titleSeen。
// 这样"我早已记过(甚至已完成)的事"再出现在屏幕上不会重复弹。
function loadVaultTitles() {
  try {
    if (!fs.existsSync(VAULT_DAILY)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(VAULT_DAILY)) {
      if (!f.endsWith('.md')) continue;
      let text; try { text = fs.readFileSync(path.join(VAULT_DAILY, f), 'utf8'); } catch (e) { continue; }
      for (const line of text.split('\n')) {
        // - [ ] / - [x] / - [-] 标题（截掉 completion/cancelled/emoji 尾注）
        const m = line.match(/^- \[[ x\-]\] (.+?)(?:\s*\[(?:completion|cancelled)::.*?\]|\s*✅.*|\s*<!--.*)?\s*$/);
        if (m && m[1].trim()) { titleSeen.add(m[1].trim()); n++; }
      }
    }
    return n;
  } catch (e) { return 0; }
}

// 启动预载入已存在标题 + vault 全量任务,避免重复弹已记录/已完成的事
function prefillTitleSeen() {
  try {
    if (fs.existsSync(SUGG_FILE)) {
      for (const line of fs.readFileSync(SUGG_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const t = JSON.parse(line).item?.title; if (t) titleSeen.add(t.trim()); } catch (e) {}
      }
    }
    const cf = path.join(__dirname, CONFIG.monitor.todoFile || 'captured_todos.md');
    if (fs.existsSync(cf)) {
      for (const line of fs.readFileSync(cf, 'utf8').split('\n')) {
        const m = line.match(/^- \[[ x]\] (.+?) <!--/);
        if (m) titleSeen.add(m[1].trim());
      }
    }
    const vaultN = loadVaultTitles();
    log('[prefill] 已载入 ' + titleSeen.size + ' 个去重标题(含 vault ' + vaultN + ' 条任务)');
  } catch (e) { log('[prefill] 失败: ' + e.message); }
}

const interval = (CONFIG.monitor.intervalSec || 30) * 1000;
process.on('uncaughtException', (e) => log('UNCAUGHT: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('UNHANDLED: ' + (e && e.stack || e)));

(async () => {
  log('=== orb-daemon 启动 (滑窗+机械去重接入vault) ===');
  prefillTitleSeen();
  await seedBaseline();
  tick();
  setInterval(tick, interval);
  // 每 60s 重扫 vault:采纳后写入的新任务、或手动加的待办,也纳入去重
  setInterval(loadVaultTitles, 60000);
})();
