<p align="center">
  <img src="assets/logo-dark.svg" width="80" alt="Orbit logo" />
</p>

<h3 align="center">Orbit</h3>
<p align="center">
  A local-first ReAct AI agent that watches your screen,<br/>
  figures out what needs your attention,<br/>
  and writes it into your knowledge base.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-32-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
</p>

---

## What It Does

You get hundreds of messages every day across Slack, WeChat, and email.
Important action items get buried. Orbit sits in your macOS menu bar and:

1. **Continuously observes** your screen via local OCR (Screenpipe)
2. **Reasons autonomously** about what needs follow-up using a ReAct agent
3. **Surfaces suggestions** in a native notification
4. **Writes structured todos** to your Obsidian vault when you accept

Everything runs locally — only anonymized screen text snippets leave your machine (for LLM inference).

## Architecture

```
Recording Layer          Reasoning Layer           Writing Layer
(Screenpipe)             (ReAct Agent)             (Pluggable Adapters)

  OCR frames  ────────▶  Scene classifier  ───▶   ┌─ Obsidian vault (default)
                         ↓ (70% early discard)    ├─ Webhook / REST API
                         ReAct judge + tools       └─ Custom adapter (20 LOC)
                         ↓
                         Multi-layer dedup
                         ↓
                         suggestions.jsonl
```

Three layers, decoupled by data contracts — swap any layer independently.

## Quick Start

```bash
# 1. Install & start Screenpipe (requires Chinese OCR)
#    https://screenpi.pe/

# 2. Clone and install
git clone https://github.com/167581103/ScreenTodo-AI.git
cd ScreenTodo-AI
npm install

# 3. Configure
cp config.example.json config.json
# → edit config.json: add your DeepSeek API key, set your name

# 4. Launch the full stack (daemon + Electron UI)
bash supervisor.sh &

# 5. Orbit icon appears in your macOS menu bar.
#    Cmd+Shift+W → open the workspace dashboard.
```

## Technical Highlights

### ReAct Agent with Tool Use
A bounded ReAct loop (max 3 reasoning steps) lets the LLM autonomously call `get_more_context` when information is insufficient — no hardcoded fallback paths.

### Two-Stage Cost-Optimized Inference
- **Stage 1**: Lightweight scene classifier (`deliver?`) routes 70%+ of frames to early discard
- **Stage 2**: Full ReAct reasoning only on actionable screens
- Result: ~96% token cost reduction vs. a naive "send everything" approach

### Geometric Window Segmentation
OCR produces flat text from multiple windows — names from app A get misattributed to messages in app B. Solved with a **union-find spatial clustering algorithm** using normalized OCR coordinates. Zero hallucination risk, purely geometric.

### Multi-Layer Deduplication
| Layer | Strategy |
|-------|----------|
| 1 — Content fingerprint | Exact hash of trigger text |
| 2 — Fuzzy matching | Longest Common Subsequence (LCS) |
| 3 — Knowledge base cross-reference | Scan vault for existing/completed todos |

### Pluggable Write Architecture
stdin/stdout JSON protocol. Swap Obsidian for Notion / Jira / Slack by implementing two actions: `add` and `find`. See [SINK_SPEC.md](./SINK_SPEC.md).

### Prompt Hot-Reload
Edit `prompts/judge.md` or `prompts/chat.md` — changes take effect on the next inference call. No restart required.

## Configuration

```jsonc
{
  "user": { "name": "Your Name" },
  "deepseek": {
    "apiBase": "https://api.deepseek.com",
    "apiKey": "sk-...",
    "model": "deepseek-chat"
  },
  "monitor": {
    "intervalSec": 5,      // polling interval
    "winFrames": 6,        // sliding window frames
    "winMaxChars": 4500    // max chars per inference
  },
  "filter": {
    "denyApps": [],        // apps to ignore
    "allowApps": []        // apps to watch (empty = all)
  }
}
```

Full schema: [config.example.json](./config.example.json) · Sink protocol: [SINK_SPEC.md](./SINK_SPEC.md)

## Optional Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ORB_TODO_WRITE` | `Todo/scripts/todo_write.py` | Path to todo writer script |
| `ORB_PYTHON` | managed Python 3.13 | Python interpreter |
| `ORB_VAULT_DAILY` | `Todo/todo/日常` | Obsidian daily vault path |
| `ORB_SP_BIN` | `screenpipe` | Screenpipe binary path |
| `ORB_WEBHOOK_URL` | — | Webhook sink target URL |

## Privacy

- `config.json` (API keys), `suggestions.jsonl` / `decisions.jsonl` (screen content) are **gitignored**
- Screen recordings stay on disk — only OCR text is sent to the LLM
- All data lives on your machine. No cloud database, no telemetry.

## License

MIT
