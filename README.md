# Claw — 屏幕感知的待办捕获 Agent

一个常驻 macOS 的本地 Agent：持续读取屏幕 OCR，用 LLM 判断哪些内容是「与你有关、需要跟进的待办」，主动弹窗建议，采纳后写入你的 Obsidian todo 仓库。

数据全部留在本地（文件即真相，不用数据库），只有屏幕文本片段会发给 LLM 做判断。

## 三层架构

按能力分层，每层只靠数据契约通信，可独立替换：

- **① 录制层**：Screenpipe 录屏 OCR → 滑动窗口取最近帧文本。（换截屏/剪贴板等输入源只动这层）
- **② 语义层**（`daemon.js`，唯一花 token）：上下文工程 + DeepSeek 判读 + 机械去重 → 命中写 `suggestions.jsonl`。
- **③ 写入层**（`sink.js` + `sinks/`，**可插拔**）：把采纳的 todo 落地到任意存储。见 [SINK_SPEC.md](./SINK_SPEC.md)。

```
录制层(Screenpipe) ─帧文本─► 语义层(daemon) ─todo─► 写入层(sink 适配器)
                                                       ├─ 本地 vault(默认)
                                                       ├─ webhook / API
                                                       └─ 你自己的存储
```

**写入层可插拔** —— 三档：
1. 本地方案（默认）：`sinks/local-vault.js`，写 Obsidian vault + 文件系统，带去重。
2. 官方连接器：`sinks/webhook.js` 等（Notion / Microsoft To Do / 滴答 陆续补）。
3. 自行接入：复制 `sinks/template.js`，对齐 `SINK_SPEC.md` 协议即可。

Electron 侧另有状态栏图标 + 建议弹窗 + 工作台窗口（采纳/忽略写 `decisions.jsonl`）。

## 成本优化（token）

- **系统 Prompt 固定**（~370 token）→ prompt cache 稳定 98% 命中。
- **滑动窗口**：每次只取最近 6 帧屏幕文本，封顶 ~4500 字（≈2600 token），不累积对话历史。
- **静止跳过**：屏幕内容哈希未变则不调用 API（挂机零消耗）。
- 稳态单次调用 ≈ 2500 token，相比"全量历史多轮"降约 96%。

## 上手

1. 装并启动 [Screenpipe](https://screenpi.pe/)（需开中文 OCR：`screenpipe record -l chinese`）。
2. `npm install`
3. `cp config.example.json config.json`，填入 DeepSeek API key。
4. `bash supervisor.sh &` 启动整套栈（常驻、自愈）。
5. 状态栏出现圆环图标；`⌘⇧W` 或点图标菜单打开工作台。

### 可选环境变量

- `ORB_TODO_WRITE`：todo 写入脚本路径
- `ORB_PYTHON`：Python 解释器路径
- `ORB_VAULT_DAILY`：Obsidian vault 日常目录

## 工作台

- 左侧按状态分：全部 / 待处理 / 已采纳 / 已忽略
- 点卡片看详情：来源 app、判断理由、触发片段、原始屏幕上下文、时间
- 底部输入框可手动加待办

## 隐私

`config.json`（含 API key）、`suggestions.jsonl` / `decisions.jsonl` / `captured_todos.md`（含真实屏幕内容）均在 `.gitignore` 中，不会入库。
