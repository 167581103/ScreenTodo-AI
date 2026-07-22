// sinks/webhook.js — 官方连接器示例:把 todo POST 到一个 HTTP 端点
// 用法: node sinks/webhook.js add   (URL 从环境变量 ORB_WEBHOOK_URL 读)
// config.json:
//   "sink": { "add": "node sinks/webhook.js add", "find": "node sinks/webhook.js find" }
// find 默认返回 not-exists(webhook 目标通常无法反查),即不去重。

const fs = require('fs');
const URL = process.env.ORB_WEBHOOK_URL || '';

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } }

(async function main() {
  const action = process.argv[2] || 'add';
  let req = {}; try { req = JSON.parse(readStdin() || '{}'); } catch (e) {}
  if (action === 'find') { process.stdout.write(JSON.stringify({ exists: false })); return; }
  if (!URL) { process.stdout.write(JSON.stringify({ ok: false, error: 'ORB_WEBHOOK_URL 未设置' })); return; }
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.todo || {}),
    });
    process.stdout.write(JSON.stringify({ ok: r.ok }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
})();
