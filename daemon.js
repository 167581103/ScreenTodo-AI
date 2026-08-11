// orb-daemon — 独立 Node 守护进程(网络逻辑)
// 多轮对话模式:启动先把「当前屏幕最近内容」作为首轮上下文(baseline)喂给模型,
// 之后每轮只把「屏幕增量」作为新 user message 追加。
// 第 N+1 轮请求的整个前缀(历史对话)都被 DeepSeek prefix cache 命中,只有本轮增量 miss → 命中率趋近 98%。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { sinkFind, CAPTURE_MARK_RE } = require('./sink.js'); // 写入层去重 + 系统捕获标记(自读循环判定)
const { sanitizeFrame } = require('./sanitize.js'); // 输入预处理:去通用噪声行(孤立数字/角标)
const { segmentFrame } = require('./segment.js'); // 几何窗口分割:按坐标把糊锅多窗口切开
const { createTools, setAllowedDirectories } = require('agent-filesystem-tools'); // 文件系统工具:读写 vault

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SUGG_FILE = path.join(__dirname, 'suggestions.jsonl');
const REJECT_FILE = path.join(__dirname, 'rejected.jsonl'); // 被拒记录(进细判但 judge=false),可恢复。场景闸门拦下的不存。
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
const { popupRequestsFromTrace, shouldRecordRejected } = require('./popup-trace');
// 工具:拉某来源(app)最近更多帧的文本,用于补全"这个/它"等指代 & 跨帧前文。
// show_popup 不在这里维护全局队列。每次 Agent run 的工具调用已经记录在返回值 _trace 中，
// handleSuggest 只消费当前 run 的 trace，避免并行判读时把其他区域的弹窗和出生证串在一起。

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

  // ── 弹窗通知：Agent 自主决定是否弹出建议给用户 ──
  // 工具本身只确认参数；真正写文件在 handleSuggest 中根据当前 run 的 trace 完成。
  show_popup: {
    def: {
      type: 'function',
      function: {
        name: 'show_popup',
        description: '弹出通知给用户。当你从屏幕中识别出需要用户处理的待办、提醒或重要信息时，调用此工具。这是你主动触达用户的唯一方式——不要只在思考里说"应该提醒用户"，直接调用工具。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '简短动宾标题,≤20字。如"回复运营排期"、"提测计平需求"' },
            reason: { type: 'string', description: '为什么值得用户关注,≤40字。引用屏幕上看到的具体信息' },
            context: { type: 'string', description: '触发此通知的屏幕原文片段(可选),≤80字' },
          },
          required: ['title', 'reason'],
        },
      },
    },
    run: async (args) => {
      const key = (args.title || '').trim();
      if (!key) return '(show_popup 失败: title 不能为空)';
      log('[tool:show_popup] requested: ' + key + ' | ' + (args.reason || ''));
      return `已记录弹窗: "${args.title}"。本轮判读完成后会自动弹出通知给用户。`;
    },
  },
};

// 挂载文件系统工具:Agent 可读写配置的允许目录
let orbConfig = { dirs: [path.join(os.homedir(), 'Todo', 'todo')], version: 1 };
const ORB_CONFIG_PATH = path.join(__dirname, 'orb-config.json');
function loadOrbConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(ORB_CONFIG_PATH, 'utf8'));
    orbConfig = { ...orbConfig, ...c };
    // 解析符号链接:validatePath 会解析真实路径,allowed dirs 也必须同步
    orbConfig.dirs = (orbConfig.dirs || []).map(d => {
      try { return fs.realpathSync(d); } catch (e) { return d; }
    });
  }
  catch (e) { /* keep defaults */ }
}
loadOrbConfig();
// 每 tick 检查 mtime 实现热加载(与 prompts 热更新同模式)
const orbConfigMtimes = {};
function reloadOrbConfigIfChanged() {
  try {
    const mt = fs.statSync(ORB_CONFIG_PATH).mtimeMs;
    if (!orbConfigMtimes.conf || orbConfigMtimes.conf !== mt) {
      orbConfigMtimes.conf = mt;
      loadOrbConfig();
      setAllowedDirectories(orbConfig.dirs);
    }
  } catch (e) {}
}
const fsTools = createTools(orbConfig.dirs, orbConfig.dirs[0]);
Object.assign(agentTools, fsTools);

const agent = createAgent(CONFIG, log, agentTools);
// 持续判读会话:历史屏幕上下文就是这一条时间线,场景闸门放行的窗口作为插入点注入。
// "已弹过窗"由会话记忆承担(机械去重保留作兜底)。重启后会话从零开始,
// 但台账(titleSeen 预填自 suggestions/vault)保证重启不重复弹。
const session = agent.createJudgeSession();

// 增量游标:用帧时间戳(ISO)而非 frame_id。Screenpipe 搜索结果的 frame_id 不完全保序(同毫秒多窗口帧会乱序),
// 用 frame_id 当游标会被乱序推高、导致真实新帧被永久丢弃(表现为"无新增屏幕,跳过")。改用 start_time 时间戳游标根治。
let lastTs = null;
let stats = { rounds: 0, compacts: 0 };
const titleSeen = new Set(); // 已建议过的标题(Agent 输出,可能漂移),避免重复弹窗
// 已判读过的"屏幕事实片段"指纹(基于触发原文 it.context,稳定客观,不受 Agent 输出措辞漂移影响)。
// 源头去重:同一段屏幕文本被相邻 tick 反复判读时,即使 Agent 吐出不同标题,也认定为同一事实、不重复产出。
const factSeen = new Set();
function normFact(s) {
  // 提取文本中的标识性序列（人名、接口名、状态码、订单号等连续字母数字串），
  // 排序去重后拼接做指纹。比截断前 60 字鲁棒：不受 OCR 标点/格式/顺序差异影响，
  // 核心标识（如 createcontentpromotionorder-trpc_21）无论出现在文本哪个位置都能稳定提取。
  const ids = (s || '').toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [];
  return [...new Set(ids)].sort().join('-').slice(0, 120);
}

// —— 机械兜底(模型不听话时的最后一道闸) ——
// 1) 自读循环:条目文本带系统捕获标记(契约见 sink.js CAPTURE_MARK) = 本系统写入存储的
//    历史捕获再次出现在屏幕上,永不重新弹窗。判定依据是系统自己的输出签名,不是猜字符串。
// 2) 陈旧事实:context/reason 自带明确日期(2026/7/22、2026-07-22、2026年7月22日)且早于今天 = 历史内容。
function isSelfCapture(it) {
  const blob = [it.title, it.reason, it.context].filter(Boolean).join(' ');
  return CAPTURE_MARK_RE.test(blob);
}
function isStaleFact(it) {
  const blob = [it.context, it.reason].filter(Boolean).join(' ');
  const m = blob.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/);
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return d < t;
}

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
  // Screenpipe API 需 Bearer 鉴权:优先 env SCREENPIPE_API_KEY,其次 config.screenpipe.apiKey
  const spKey = process.env.SCREENPIPE_API_KEY || (CONFIG.screenpipe && CONFIG.screenpipe.apiKey) || '';
  const headers = spKey ? { Authorization: `Bearer ${spKey}` } : {};
  try {
    const r = await fetch(url, { signal: ac.signal, headers });
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
    const configured = process.env.ORB_SP_DATA || CONFIG.screenpipe?.dataDir;
    // 优先显式配置，其次兼容工作区、项目目录和用户目录下的常见位置。
    const dirs = [
      configured,
      path.join(path.dirname(__dirname), '.screenpipe'),
      path.join(__dirname, '.screenpipe'),
      path.join(os.homedir(), '.screenpipe'),
    ].filter(Boolean);
    const cands = [...new Set(dirs)].map(dir => path.join(dir, 'db.sqlite'));
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

// 启动即判一次当前屏幕(baseline seed):复用滑窗 fetchContext,避免启动时发超大 prompt。
async function seedBaseline() {
  try {
    const inc = await fetchContext();
    if (inc.lines.length) {
      const screenText = inc.lines.join('\n');
      lastWinHash = cheapHash(screenText);
      log('[baseline] 窗口 ' + inc.lines.length + ' 行 ' + screenText.length + '字');
      await judgeScreen(inc, 'baseline');
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

// 场景判的精简输入:只取头部,场景靠结构+特征词识别,不靠通读内容。总封顶 ~800 字。
function sceneText(lines) {
  const heads = lines.map((l) => l.slice(0, 90));
  let s = heads.join('\n');
  if (s.length > 800) s = s.slice(0, 800);
  return s;
}

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
        // 每区域标注简短指纹(fq=前6字)用于跨帧去重
        const fq = fp.slice(0, 6);
        lines.push(`[${f.app}·${fq}] ${clean.slice(-PERFRAME)}`);
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
  // ── 第一阶段：处理当前 Agent run 通过 show_popup 发出的请求 ──
  // 每次 run 的 trace 天然隔离；即使 judgeGroups 并行执行，也不会消费到其他区域的弹窗。
  const tp = popupRequestsFromTrace(meta?.trace);
  for (const te of tp) {
    const key = (te.item.title || '').trim();
    if (!key) continue;
    if (isSelfCapture(te.item)) { log('[guard] orb 历史捕获标记(自读循环),跳过: ' + key); continue; }
    if (isStaleFact(te.item)) { log('[guard] 事实日期早于今天,跳过: ' + key); continue; }
    // 源头去重：按触发原文片段指纹
    const fp = normFact(te.item.context);
    if (fp && fp.length >= 8) {
      if (factSeen.has(fp)) { log('[tool-popup dedup] 同一屏幕事实已判过,跳过: ' + key); continue; }
      factSeen.add(fp);
    }
    if (isDupTitle(key)) { log('[tool-popup dedup] 本会话去重跳过: ' + key); continue; }
    // 在异步查 sink 前先占位，避免两个并行区域同时通过检查后重复写入同一标题。
    titleSeen.add(key);
    let existsInStore = false;
    try { existsInStore = await sinkFind({ title: key }); } catch (e) {}
    if (existsInStore) { log('[tool-popup dedup] 存储已有,跳过: ' + key); continue; }
    const rec = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      item: te.item,
      apps: meta?.apps || [],
      raw: meta?.raw || te.item.context || '',
      ts: new Date().toISOString(),
      trigger: 'agent-tool',
      birth: {
        scene: meta?.scene ? { name: meta.scene.scene, deliver: meta.scene.deliver, why: meta.scene.why } : null,
        trace: meta?.trace || [],
        steps: meta?.steps || 1,
        dialog: meta?.dialog || [],   // Agent 完整判读对话回放
        thinking: meta?.thinking || '', // Agent 真实自然语言思考
      },
    };
    ensureSuggFile();
    fs.appendFileSync(SUGG_FILE, JSON.stringify(rec) + '\n');
    backupSugg();
    log('[agent-tool] popup fired: ' + key + ' | ' + (te.item.reason || ''));
  }

  // ── 第二阶段：传统 JSON 输出路径(兼容旧模式或 Agent 未用工具的情况) ──
  let items = [];
  if (Array.isArray(j.items)) items = j.items;
  else if (j.suggest && j.title) items = [j];
  // 新版 prompt 以 show_popup 为正向结论，随后只输出自然语言；safeParse 会把自然语言视为
  // suggest:false。只要当前 run 调过 show_popup，就不能再把同一屏幕写进 rejected.jsonl。
  // 被拒(suggest=false):存进 rejected.jsonl 作"回收站",可恢复。
  if (shouldRecordRejected(j, tp.length, items.length)) {
    if (meta && meta.raw) {
      const rj = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        screen: String(meta.raw).slice(0, 1200),
        scene: meta.scene ? { name: meta.scene.scene, why: meta.scene.why } : null,
        dialog: meta.dialog || [],
        thinking: meta.thinking || '',
        ts: new Date().toISOString(),
      };
      try { fs.appendFileSync(REJECT_FILE, JSON.stringify(rj) + '\n'); } catch (e) {}
    }
    return;
  }
  for (const it of items) {
    const key = (it.title || '').trim();
    if (!key) continue;
    if (isSelfCapture(it)) { log('[guard] orb 历史捕获标记(自读循环),跳过: ' + key); continue; }
    if (isStaleFact(it)) { log('[guard] 事实日期早于今天,跳过: ' + key); continue; }
    const fp = normFact(it.context);
    if (fp && fp.length >= 8) {
      if (factSeen.has(fp)) { log('[dedup] 同一屏幕事实已判过,跳过: ' + key); continue; }
      factSeen.add(fp);
    }
    if (isDupTitle(key)) { log('[dedup] 本会话去重跳过: ' + key); continue; }
    titleSeen.add(key);
    let existsInStore = false;
    try { existsInStore = await sinkFind({ title: key }); } catch (e) {}
    if (existsInStore) { log('[dedup] 存储已有,跳过: ' + key); continue; }
    const rec = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      item: it,
      apps: meta?.apps || [],
      raw: meta?.raw || '',
      ts: new Date().toISOString(),
      birth: {
        scene: meta?.scene ? { name: meta.scene.scene, deliver: meta.scene.deliver, why: meta.scene.why } : null,
        trace: meta?.trace || [],
        steps: meta?.steps || 1,
        dialog: meta?.dialog || [],
        thinking: meta?.thinking || '',
      },
    };
    ensureSuggFile();
    fs.appendFileSync(SUGG_FILE, JSON.stringify(rec) + '\n');
    backupSugg();
    log('发现隐藏需求: ' + it.title + ' | ' + (it.reason || ''));
  }
}

// 捕获层判读:所有区域上下文合并,单次场景闸门 + 单次 Agent 判读。
async function judgeScreen(inc, label) {
  const screenText = inc.lines.join('\n');
  const sc = await agent.classifyScene(sceneText(inc.lines));
  if (!sc.deliver) { log(`[${label}:scene] ${sc.scene} · 不派活,跳过 (${sc.why})`); return; }
  log(`[${label}:scene] ${sc.scene} · 可能派活 → 进细判 (会话 ${Math.round(session.chars() / 1000)}k字)`);
  const j = await session.judge(screenText);
  log(`[${label}:judge] suggest=` + j.suggest + (j.suggest ? ' ' + (j.items ? j.items.map(i => i.title).join('; ') : j.title) : ''));
  await handleSuggest(j, { apps: inc.apps, raw: screenText.slice(0, 2000), scene: sc, trace: j._trace || [], steps: j._steps || 1, dialog: j._dialog || [], thinking: j._thinking || '' });
  // 上下文预算:超阈值则压缩旧段(摘要 + 已通知台账 + 最近若干插入点),会话继续演进
  const MAXS = (CONFIG.monitor.sessionMaxChars || 60000);
  if (session.chars() > MAXS) {
    try {
      session.setLedger([...titleSeen]);
      const summary = await agent.runLight(
        '你是屏幕监控会话的上下文压缩器。把给定历史压缩成不超过400字的摘要:保留①已弹窗通知过的事项标题;②正在进行、未完结的线索(谁在等用户推进什么);③关键人名/事项名。丢弃界面元素、导航、闲聊等噪声。只输出摘要正文。',
        session.dump(4, 12000));
      session.compact(summary, CONFIG.monitor.compactRecent || 2);
      log(`[session] 上下文压缩完成 → ${Math.round(session.chars() / 1000)}k字`);
    } catch (e) { log('[session] 压缩失败(下轮重试): ' + e.message); }
  }
}

let ticking = false;
async function tick() {
  if (fs.existsSync(PAUSE_FILE)) return;
  if (ticking) { log('[tick] 上一轮未完成,跳过'); return; }
  ticking = true;
  reloadOrbConfigIfChanged();
  const savedLastTs = lastTs;
  try {
    const inc = await fetchContext();
    if (!inc.lines.length) { log('[tick] 无屏幕内容,跳过'); return; }
    const screenText = inc.lines.join('\n');
    const h = cheapHash(screenText);
    if (h === lastWinHash) { return; }
    lastWinHash = h;
    stats.rounds = (stats.rounds || 0) + 1;
    log(`[tick #${stats.rounds}] 窗口 ${inc.lines.length} 行 ${screenText.length}字` + (inc.truncated ? ' [截断]' : '') + (inc.apps.includes('企业微信') ? ' [群聊]' : ''));
    await judgeScreen(inc, 'tick');
  } catch (e) {
    lastTs = savedLastTs;
    log('tick 错误: ' + e.message);
  } finally {
    ticking = false;
  }
}

// Obsidian vault 日常/ 目录:接入真正的 todo 文件系统做机械去重(可环境变量覆盖)
const VAULT_DAILY = process.env.ORB_VAULT_DAILY || path.join(os.homedir(), 'Todo', 'todo', '日常');

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
        try {
          const r = JSON.parse(line);
          if (r.item?.title) titleSeen.add(r.item.title.trim());
          const fp = normFact(r.item?.context); // 已产出事实的原文指纹,重启后不重判同一屏幕事实
          if (fp && fp.length >= 8) factSeen.add(fp);
        } catch (e) {}
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

// 单实例锁:防止多个 daemon 并发跑(并发读写 suggestions.jsonl 是数据损坏的隐患来源之一)。
// 用 PID 文件 + kill(0) 探活:已有活实例则本进程退出。
const LOCK_FILE = path.join(__dirname, 'daemon.lock');
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try { process.kill(oldPid, 0); log('[lock] 已有 daemon 实例在跑(pid=' + oldPid + '),本进程退出'); process.exit(0); }
        catch (e) { /* 老进程已死,抢锁 */ }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) { log('[lock] 获取锁失败(忽略): ' + e.message); }
}
process.on('exit', () => { try { if (fs.existsSync(LOCK_FILE) && parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) {} });

// 确保 suggestions.jsonl 存在(被误删/首次运行都自愈),让 appendFileSync 永不因文件缺失丢数据。
function ensureSuggFile() {
  try { if (!fs.existsSync(SUGG_FILE)) { fs.writeFileSync(SUGG_FILE, ''); log('[recover] suggestions.jsonl 不存在,已重建空文件'); } } catch (e) {}
}

// 轻量自动备份:每次 append 后有内容时,滚动备份到 suggestions.bak(单份,防误删/误清可回滚)。
function backupSugg() {
  try {
    if (!fs.existsSync(SUGG_FILE)) return;
    const cur = fs.readFileSync(SUGG_FILE, 'utf8');
    if (cur.trim()) fs.writeFileSync(SUGG_FILE + '.bak', cur); // 只在非空时覆盖备份,避免空文件把好备份冲掉
  } catch (e) {}
}

(async () => {
  acquireLock();
  ensureSuggFile();
  log('=== orb-daemon 启动 (持续会话时间线+场景闸门+机械去重兜底) ===');
  prefillTitleSeen();
  session.setLedger([...titleSeen]); // 台账:重启后不重复弹已通知过的事
  await seedBaseline();
  tick();
  setInterval(tick, interval);
  // 每 60s 重扫 vault:采纳后写入的新任务、或手动加的待办,也纳入去重
  setInterval(loadVaultTitles, 60000);
  // 每 2 分钟备份一次 suggestions(非空才备份),防误删/误清
  setInterval(backupSugg, 120000);
})();
