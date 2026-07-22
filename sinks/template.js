// sinks/template.js — 自己接入写入层的模板
// 复制本文件改成你的存储(Notion / Microsoft To Do / 滴答 / 自建 API ...)。
// 协议见 SINK_SPEC.md:stdin 收 {action, todo},stdout 回 JSON。
//
// config.json:
//   "sink": { "add": "node sinks/template.js add", "find": "node sinks/template.js find" }

const fs = require('fs');
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } }

// TODO: 换成你的"新增待办"实现
async function addTodo(todo) {
  // 示例:调你的 API / SDK / 写文件 ...
  // await fetch('https://your-api/todos', { method:'POST', body: JSON.stringify(todo) });
  return { ok: true };
}

// TODO: 换成你的"查是否已存在"实现(可选,不实现就返回 exists:false = 不去重)
async function findTodo(todo) {
  // 示例:按 todo.title 去你的存储里查
  return { exists: false };
}

(async function main() {
  const action = process.argv[2] || 'add';
  let req = {}; try { req = JSON.parse(readStdin() || '{}'); } catch (e) {}
  const todo = req.todo || {};
  try {
    const r = (action === 'find') ? await findTodo(todo) : await addTodo(todo);
    process.stdout.write(JSON.stringify(r));
  } catch (e) {
    process.stdout.write(JSON.stringify(action === 'find' ? { exists: false } : { ok: false, error: String(e.message || e) }));
  }
})();
