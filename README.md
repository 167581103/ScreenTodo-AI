# Claw — 屏幕感知的待办捕获 Agent

一个常驻 macOS 的本地 Agent：持续读取屏幕 OCR，用 LLM 判断哪些内容是「与你有关、需要跟进的待办」，主动弹窗建议，采纳后写入你的 Obsidian todo 仓库。

数据全部留在本地（文件即真相，不用数据库），只有屏幕文本片段会发给 LLM 做判断。

## 架构

三个进程，由 `supervisor.sh` 守护、自愈：

- **Screenpipe**（外部依赖）：持续录屏 + OCR，提供 `localhost:3030` 查询接口。
- **daemon.js**：判断引擎。滑动窗口取最近屏幕文本 → DeepSeek 判读 → 命中写 `suggestions.jsonl`。
- **main.js**（Electron）：状态栏图标 + 建议弹窗 + 工作台窗口。采纳/忽略写 `decisions.jsonl`，采纳的写入 Obsidian vault。

```
Screenpipe(OCR) ──► daemon.js(判读) ──► suggestions.jsonl
                                              │
                          Electron(弹窗/工作台) ◄┘ ──► Obsidian vault
```

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
