// workspace-data.js — 工作台数据层
// 设计原则:文件即真相,不引入 SQLite。
//  - 捕获:读 orb 的 suggestions.jsonl(追加式 JSONL)
//  - 待办:解析 Obsidian vault 日常/ 下的 - [ ] 任务行
//  - 例程:解析 life-os 规划 MD 的 ## 章节
//  - 轨迹:实时调 Screenpipe 本地 API 取 OCR 帧
// 所有函数返回普通 JS 对象数组,供 IPC 传给渲染进程。

const fs = require('fs');
const path = require('path');
const os = require('os');

const SUGG_FILE = path.join(__dirname, 'suggestions.jsonl');
const DECISIONS_FILE = path.join(__dirname, 'decisions.jsonl');
const VAULT_DAILY = process.env.ORB_VAULT_DAILY || '/Users/chancguo/Todo/todo/日常';
const LIFEOS_PLAN = path.join(os.homedir(), 'life-os/规划/阶段性目标.md');
const SCREENPIPE = 'http://localhost:3030';

// ---------- 基础读取 ----------
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (e) {}
  }
  return out;
}

function tagFromContext(ctx) {
  if (!ctx) return '屏幕';
  if (ctx.includes('群聊') || ctx.includes('企业微信')) return '群聊';
  if (ctx.includes('晨会')) return '晨会';
  if (ctx.includes('走查')) return '走查';
  if (ctx.includes('CodeBuddy') || ctx.includes('codebuddy')) return 'CodeBuddy';
  if (ctx.includes('元宝')) return '元宝';
  return '屏幕';
}

function parseVaultTasks(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(dir, f);
    let text;
    try { text = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
    const mtime = fs.statSync(fp).mtime;
    for (const line of text.split('\n')) {
      const m = line.match(/^- \[ \] (.+?)(?:\s*<!--.*?-->)?\s*$/);
      if (m) out.push({ title: m[1].trim(), file: f.replace(/\.md$/, ''), time: mtime.getTime() });
    }
  }
  return out;
}

// ---------- 回忆(捕获 + 待办 合并,按时间倒序) ----------
function getRecall() {
  const decisions = {};
  for (const d of readJsonl(DECISIONS_FILE)) { if (d.id) decisions[d.id] = d.decision; }
  const items = [];
  for (const rec of readJsonl(SUGG_FILE)) {
    const it = rec.item || {};
    const status = rec.id ? (decisions[rec.id] || null) : null;
    items.push({
      kind: 'capture',
      id: rec.id || null,
      title: it.title || '未命名',
      reason: it.reason || '',
      context: it.context || '',
      apps: rec.apps || [],
      raw: rec.raw || '',
      tag: tagFromContext(it.context) === '屏幕' && rec.apps && rec.apps.length ? rec.apps[0] : tagFromContext(it.context),
      time: rec.ts ? Date.parse(rec.ts) : 0,
      status, // null=pending, 'accepted'=已采纳, 'ignored'=已忽略
    });
  }
  for (const t of parseVaultTasks(VAULT_DAILY)) {
    items.push({ kind: 'task', title: t.title, file: t.file, tag: '待办', time: t.time, status: null });
  }
  items.sort((a, b) => b.time - a.time);
  return items.slice(0, 50);
}

// ---------- 会议(从群聊/晨会类捕获派生) ----------
function getMeetings() {
  const out = [];
  const seen = new Set();
  for (const rec of readJsonl(SUGG_FILE)) {
    const it = rec.item || {};
    const tag = tagFromContext(it.context);
    if (!(tag === '群聊' || tag === '晨会' || tag === '走查')) continue;
    const key = (it.title || '').slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    const attendees = [...(it.context || '').matchAll(/@([\w一-龥]+)/g)].map((m) => m[1]);
    out.push({
      title: it.title || '群聊讨论',
      time: rec.ts ? rec.ts.replace('T', ' ').slice(0, 16) : '',
      tag,
      attendees: [...new Set(attendees)].slice(0, 6),
      takeaway: it.title || '',
    });
  }
  return out.slice(0, 20);
}

// ---------- 例程(解析 life-os 规划 MD 的 ## 章节) ----------
function getRoutines() {
  if (!fs.existsSync(LIFEOS_PLAN)) return [];
  const lines = fs.readFileSync(LIFEOS_PLAN, 'utf8').split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (cur) out.push(cur);
      cur = { name: h[1].trim(), desc: '' };
    } else if (cur && line.trim().startsWith('-')) {
      cur.desc += (cur.desc ? '；' : '') + line.trim().replace(/^-\s*/, '');
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, 12);
}

// ---------- 轨迹(实时 Screenpipe OCR 帧) ----------
async function getTimeline() {
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const url = `${SCREENPIPE}/search?limit=50&content_type=ocr&start_time=${encodeURIComponent(since)}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const data = j.data || j.results || [];
    return data
      .map((d) => {
        const c = d.content || {};
        return {
          app: (c.app_name || '').trim() || '屏幕',
          text: (c.text || '').replace(/\s+/g, ' ').slice(0, 180),
          ts: c.timestamp || d.timestamp || null,
        };
      })
      .filter((x) => x.text);
  } catch (e) {
    return [];
  }
}

// ---------- 搜索 ----------
function search(q) {
  const items = getRecall();
  const kw = (q || '').toLowerCase();
  if (!kw) return items;
  return items.filter(
    (i) => (i.title || '').toLowerCase().includes(kw) || (i.context || '').toLowerCase().includes(kw)
  );
}

module.exports = { getRecall, getMeetings, getRoutines, getTimeline, search };
