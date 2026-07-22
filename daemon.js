// orb-daemon — 独立 Node 守护进程(网络逻辑)
// 多轮对话模式:启动先把「当前屏幕最近内容」作为首轮上下文(baseline)喂给模型,
// 之后每轮只把「屏幕增量」作为新 user message 追加。
// 第 N+1 轮请求的整个前缀(历史对话)都被 DeepSeek prefix cache 命中,只有本轮增量 miss → 命中率趋近 98%。
const fs = require('fs');
const path = require('path');
const { sinkFind } = require('./sink.js'); // 写入层去重:查 todo 是否已存在于配置的存储
const { sanitizeFrame } = require('./sanitize.js'); // 输入预处理:剥离导航态/UI chrome 噪声

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SUGG_FILE = path.join(__dirname, 'suggestions.jsonl');
const PAUSE_FILE = path.join(__dirname, 'monitor.paused');
const LOG_PATH = path.join(__dirname, 'daemon.log');

function log(m) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}

const PROMPT = `你是屏幕监控 Agent。每次发来一段当前屏幕的 OCR 文本，你判读并返回待办。

【捕获规则】
只捕与 chancguo(用户)有关的客观事实——别人对其要求、指派、等待其产出、或其自己写的 Todo。
- 私聊中对方对 chancguo 的要求(如"提单给我""帮我看下")→捕
- 群聊中 @chancguo 或明确指派→捕
- 群聊"你们/大家/各位/@所有人"向全体广播且未 @chancguo → **不捕**(群体任务≠个人待办)
- 纯他人互聊、闲聊、寒暄→不捕
- 自己写的 Todo 列表→捕(如"Todo: xxx 动作: xxx")
- AI 助手(元宝/豆包)给的建议→捕;纯生成/娱乐→不捕
- WorkBuddy 排障自语("验证健康/重启/dump脚本")→不捕

【反幻觉铁律 — 最重要,违反即错】
- @ 谁就是给谁。若消息里的 @ 列表是别人(如"@louismao @marisolxu @oneyli"),而**没有 @chancguo/@郭辰**,则这条**不是**指派给 chancguo → **必须 suggest=false**。
- **禁止编造锚点**:不许在 reason 里写"明确指派 chancguo/需 chancguo 参与"之类,除非原文真的 @了 chancguo 或点名"郭辰/你(单数明确指 chancguo)"。看不到 chancguo 的名字/@,就是与他无关。
- 话题属于 chancguo 领域(广告/互选/一口价等) ≠ 指派给 chancguo。别人 @别人讨论你熟悉的话题,也不捕。
- 判断顺序:先找"chancguo/郭辰"是否被 @ 或点名 → 没有就直接 false,不要再脑补关联。

【宁滥勿缺】不确定时倾向捕,漏比多严重。弱信号:"记得做/回头/待跟进/ddl/跟进/复盘/对齐/审评/排期/同步"、告警/异常/决定/结论。

输出 JSON(只此一份,无额外文字):
{"suggest":true,"items":[{"title":"简短动宾≤20字","reason":"为什么相关≤40字","context":"原文片段≤50字"}]}
无待办则 {"suggest":false}`;

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
    const ignoreApps = CONFIG.monitor.ignoreApps || [];
    const out = [];
    for (const it of items) {
      const c = it.content || {};
      const app = c.app_name || '';
      const rawTxt = (c.text || '').trim();
      if (ignoreApps.includes(app)) continue;
      if (app === '' && /^WorkBuddy/.test(rawTxt)) continue;
      // 输入预处理(架构层):剥离 UI chrome / 会话列表噪声,只把真内容送进语义层
      const txt = sanitizeFrame(rawTxt);
      if (!txt) continue; // 这帧清洗后无有效内容(纯导航态)→ 不喂 LLM
      out.push({ fid: c.frame_id || 0, app, txt, ts: c.timestamp || null });
    }
    return out;
  } finally {
    clearTimeout(t);
  }
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
      const j = await judge([{ role: 'system', content: PROMPT }, { role: 'user', content: screenText }]);
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
  for (const f of picked) lines.push(`[${f.app}] ${f.txt.slice(-PERFRAME)}`);
  lastTs = maxTs;
  // 总额字符硬上限:丢最旧行、保最新行
  let tot = lines.reduce((s, l) => s + l.length, 0);
  let truncated = false;
  while (lines.length > 1 && tot > MAXC) { tot -= lines.shift().length; truncated = true; }
  return { lines, apps: [...apps], truncated };
}

async function judge(messages) {
  const body = {
    model: CONFIG.deepseek.model,
    messages,
    response_format: { type: 'json_object' },
    temperature: 0.2,
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(CONFIG.deepseek.apiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.deepseek.apiKey}` },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    const u = d.usage || {};
    const hit = u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0;
    const total = u.prompt_tokens || 0;
    if (total > 0) log(`[cache] 命中 ${hit}/${total} (${(hit / total * 100).toFixed(0)}%)`);
    const content = d.choices?.[0]?.message?.content || '{}';
    return JSON.parse(content);
  } finally { clearTimeout(t); }
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
    const j = await judge([{ role: 'system', content: PROMPT }, { role: 'user', content: screenText }]);
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
