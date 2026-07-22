# 写入层 Sink 规范

Claw 的三层架构中，**写入层（sink）** 负责把语义层判出的 todo 落地到某个存储。
存储用什么不重要——文件、Notion、Microsoft To Do、滴答、数据库、webhook 都行。
只要实现本规范定义的接口，即可接入。

三档使用方式：
1. **本地方案（默认）**：`sinks/local-vault.js`，写入 Obsidian vault + 文件系统，支持去重。开箱即用。
2. **官方连接器**：`sinks/` 下提供的适配器，如 `sinks/webhook.js`（POST 到任意 HTTP 端点）。后续会补 Notion / Microsoft To Do / 滴答等。
3. **自行接入**：复制 `sinks/template.js` 改成你的存储，对齐下面的协议即可。

## 协议

一个 sink 是**一个可执行命令**（脚本 / 二进制 / `node xxx.js` / `curl` 包装均可）。
Claw 通过 **stdin 传入一个 JSON 请求**，从 **stdout 读回一个 JSON 响应**。

### 请求（stdin）

```json
{ "action": "add" | "find", "todo": { ... } }
```

`todo` 对象字段：

| 字段 | 说明 |
|------|------|
| `title` | 待办标题（动宾短语） |
| `reason` | 为什么捕获（判断理由） |
| `context` | 触发的屏幕原文片段 |
| `raw` | 触发时更宽的原始屏幕上下文 |
| `apps` | 来源 app 列表 |
| `time` | ISO 时间 |

### action: `add`

把 todo 写入存储。响应：

```json
{ "ok": true }
```

### action: `find`

查询该 todo 是否**已存在**（用于去重，避免重复捕获已记录的事）。
sink 根据 `todo.title` 判断。响应：

```json
{ "exists": true | false }
```

若 sink 不支持去重，返回 `{ "exists": false }` 即可（不影响写入，只是不去重）。

## 配置

在 `config.json` 里指定用哪个 sink：

```json
"sink": {
  "add":  "python3 sinks/local-vault.py add",
  "find": "python3 sinks/local-vault.py find"
}
```

- `add` / `find` 是两条命令模板，Claw 会启动它并从 stdin 喂 JSON。
- 只填 `add` 也能跑（不去重）。
- 命令的工作目录是项目根目录，可用相对路径。

## 自己接入的最小例子

```bash
#!/bin/bash
# my-sink.sh  —— 把 todo 发到自己的 API
req=$(cat)                    # 从 stdin 读 JSON
action=$(echo "$req" | jq -r .action)
if [ "$action" = "add" ]; then
  echo "$req" | jq .todo | curl -s -X POST https://my-api/todos -d @-
  echo '{"ok":true}'
elif [ "$action" = "find" ]; then
  echo '{"exists":false}'     # 不做去重
fi
```

配置：
```json
"sink": { "add": "bash sinks/my-sink.sh", "find": "bash sinks/my-sink.sh" }
```
