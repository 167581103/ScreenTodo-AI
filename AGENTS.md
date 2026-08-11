# AGENTS.md

## Cursor Cloud specific instructions

Orbit (a.k.a. `screen-orb` / ScreenTodo) is a **local-first Electron desktop app** (macOS menu-bar app in production). It has two runtime processes plus two external dependencies. See `README.md` for the product overview, config schema, and `SINK_SPEC.md` for the write-layer protocol.

### Services / how to run (dev mode)

- **daemon (`node daemon.js`)** — network/reasoning layer. Polls Screenpipe for OCR frames, runs the ReAct agent (`agent.js` → DeepSeek), and appends suggestions to `suggestions.jsonl`.
- **Electron UI (`main.js`)** — renders the tray icon, suggestion popups, and the workspace window. Watches `suggestions.jsonl` and handles Add/Ignore.

Run the UI on the VM display (do NOT use `start.sh`/`supervisor.sh`; those hardcode macOS paths under `/Users/apple/...` and a WorkBuddy-managed node, so they fail on Linux):

```bash
node daemon.js &
DISPLAY=:1 env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron . --no-sandbox --disable-gpu
```

- `config.json` is **gitignored**; the app crashes on start if it is missing. The update script creates it from `config.example.json` when absent. Edit it to add a real `deepseek.apiKey` / `screenpipe.apiKey` when doing full end-to-end work.
- The `bus.cc`/dbus errors Electron prints on this headless VM are harmless.

### External dependencies (not available by default here)

- **Screenpipe** (local OCR server on `http://localhost:3030`) is a separate binary and is not installed. Without it, the daemon logs `tick 错误: fetch failed` every ~5s — this is expected and harmless.
- **DeepSeek API key** is required for the ReAct judge and the chat agent; the example config ships a placeholder, so LLM-driven flows won't produce output until a real key is set.

### Testing the UI + write pipeline without external services

The three layers are decoupled by data contracts, so you can exercise the core "surface suggestion → accept → write todo" flow without Screenpipe/DeepSeek: append a daemon-shaped record (`{id, item:{title,reason,context,...}, apps, raw, ts, birth}`) to `suggestions.jsonl` while Electron is running. The popup surfaces it; clicking **添加待办 (Add)** logs `accepted` to `decisions.jsonl` and writes the todo. Note the popup **auto-dismisses (Ignore) after 20s**, so act quickly.

The default sink (`sinks/local-vault.js`) shells out to a Python `todo_write.py` that is not present here; when it fails, `addTodo` falls back to appending to `captured_todos.md`. That fallback is the expected behavior in this environment.

Runtime/data files are gitignored and safe to reset for a clean demo: `suggestions.jsonl`, `decisions.jsonl`, `captured_todos.md`, `rejected.jsonl`, `sessions.json`, `*.log`, `*.pid`.

### Lint / tests

There is no configured lint or test framework (no `test`/`lint` npm scripts, no ESLint config). Use `node --check <file>.js` for a quick syntax sanity check across the JS sources.
