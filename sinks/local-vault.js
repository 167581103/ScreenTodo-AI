// sinks/local-vault.js — 默认写入层:Obsidian vault + 文件系统 + todo_write.py
// 用法(由 sink.js 调起): node sinks/local-vault.js add|find,stdin 传 {action,todo},stdout 回 JSON。
// add : 调 todo_write.py apply 写入 vault 日常/
// find: 扫 vault 日常/ 所有任务(- [ ]/- [x]/- [-])做机械去重

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VAULT_DAILY = process.env.ORB_VAULT_DAILY || '/Users/apple/Todo/todo/日常';
const TODO_WRITE = process.env.ORB_TODO_WRITE || '/Users/apple/WorkBuddy/Todo/scripts/todo_write.py';
const PYTHON = process.env.ORB_PYTHON || 'python3';

const norm = (s) => (s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function vaultTitles() {
  const set = new Set();
  if (!fs.existsSync(VAULT_DAILY)) return set;
  for (const f of fs.readdirSync(VAULT_DAILY)) {
    if (!f.endsWith('.md')) continue;
    let text; try { text = fs.readFileSync(path.join(VAULT_DAILY, f), 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      const m = line.match(/^- \[[ x\-]\] (.+?)(?:\s*\[(?:completion|cancelled)::.*?\]|\s*✅.*|\s*<!--.*)?\s*$/);
      if (m && m[1].trim()) set.add(norm(m[1].trim()));
    }
  }
  return set;
}

function doAdd(todo) {
  const ts = new Date().toLocaleString('zh-CN');
  const ctx = (todo.context || todo.raw || '').replace(/\n/g, ' ').slice(0, 120);
  const plan = { tasks: [{ title: todo.title, note: `来源:${ctx} | ${ts} (orb)` }] };
  const tmp = path.join(__dirname, `.tmp_plan_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(plan));
  try {
    execFileSync(PYTHON, [TODO_WRITE, 'apply', '--plan', tmp], { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

function doFind(todo) {
  const t = norm(todo.title || '');
  if (!t) return { exists: false };
  const titles = vaultTitles();
  if (titles.has(t)) return { exists: true };
  for (const s of titles) { if (t.includes(s) || s.includes(t)) return { exists: true }; }
  return { exists: false };
}

(function main() {
  const action = process.argv[2] || 'add';
  let req = {};
  try { req = JSON.parse(readStdin() || '{}'); } catch (e) {}
  const todo = req.todo || {};
  try {
    const r = (action === 'find') ? doFind(todo) : doAdd(todo);
    process.stdout.write(JSON.stringify(r));
  } catch (e) {
    process.stdout.write(JSON.stringify(action === 'find' ? { exists: false } : { ok: false, error: String(e.message || e) }));
  }
})();
