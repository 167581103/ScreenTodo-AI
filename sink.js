// sink.js — 写入层分发器
// 读 config.json 的 sink 配置,把 todo 通过 stdin JSON 喂给配置的命令,从 stdout 读回 JSON。
// 见 SINK_SPEC.md。默认本地方案 = sinks/local-vault.js(包装 vault + todo_write.py)。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
// 默认 sink:本地 vault 方案(零配置也能用)
const DEFAULT_SINK = {
  add: `${process.execPath} sinks/local-vault.js add`,
  find: `${process.execPath} sinks/local-vault.js find`,
};
const SINK = Object.assign({}, DEFAULT_SINK, CONFIG.sink || {});

// 运行一条 sink 命令,stdin 喂 req JSON,解析 stdout JSON。超时/失败返回 null。
function runSink(cmdLine, req, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!cmdLine) return resolve(null);
    // 简单分词(命令 + 参数);复杂命令建议包装成脚本
    const parts = cmdLine.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    let child;
    try {
      child = spawn(cmd, args, { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve(null); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim() || '{}')); } catch (e) { resolve(null); }
    });
    try { child.stdin.write(JSON.stringify(req)); child.stdin.end(); } catch (e) {}
  });
}

// 写入一条 todo。返回 true=成功。
async function sinkAdd(todo) {
  const r = await runSink(SINK.add, { action: 'add', todo });
  return !!(r && r.ok);
}

// 查 todo 是否已存在(去重)。sink 不支持则视为不存在。
async function sinkFind(todo) {
  if (!SINK.find) return false;
  const r = await runSink(SINK.find, { action: 'find', todo: typeof todo === 'string' ? { title: todo } : todo });
  return !!(r && r.exists);
}

module.exports = { sinkAdd, sinkFind, SINK };
