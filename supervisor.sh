#!/bin/bash
# supervisor.sh — 常驻守护:拉起并看护 screenpipe + daemon.js + electron
# 用 Bash 工具的 run_in_background 启动,在桌面会话里常驻,每 ~10s 检查,挂了就重启。
# 对 screenpipe 额外做健康巡检:卡死(stale)或长时间无新帧 → 杀掉重启(自愈)。
cd "$(dirname "$0")"
NODE_BIN="/Users/chancguo/.workbuddy/binaries/node/versions/22.22.2/bin/node"
SP_BIN="/Users/chancguo/node_modules/@screenpipe/cli-darwin-arm64/bin/screenpipe"
SP_DATA="/Users/chancguo/WorkBuddy/Todo/.screenpipe"
LOG="supervisor.log"

# pidfile 守护:用 kill -0 精确判断,避免 pgrep 瞬时漏判导致重复拉起
alive() { local f="$1"; [ -f "$f" ] && kill -0 "$(cat "$f" 2>/dev/null)" 2>/dev/null; }
# 若进程在跑但 pidfile 丢了,重建 pidfile;否则按指定命令启动
ensure() {
  local pidfile="$1" pattern="$2" startcmd="$3"
  if alive "$pidfile"; then return 0; fi
  local p; p=$(pgrep -f "$pattern" 2>/dev/null | head -1)
  if [ -n "$p" ]; then echo "$p" > "$pidfile"; return 0; fi
  eval "$startcmd"
  echo $! > "$pidfile"
  return 1
}

SP_STARTED=0
sp_health_ok() { [ $(( $(date +%s) - SP_STARTED )) -le 60 ] || "$NODE_BIN" sp_health.js >/dev/null 2>&1; }

echo "[$(date)] supervisor 启动" >> "$LOG"
while true; do
  # —— Screenpipe 录制层 ——
  if ! alive sp.pid; then
    if pgrep -f "screenpipe record" >/dev/null 2>&1; then
      pgrep -f "screenpipe record" | head -1 > sp.pid
    else
      echo "[$(date)] 启动 screenpipe(-l chinese)" >> "$LOG"
      nohup "$SP_BIN" record --disable-audio -l chinese --data-dir "$SP_DATA" >> screenpipe.out 2>&1 &
      echo $! > sp.pid
      SP_STARTED=$(date +%s)
    fi
  else
    now=$(date +%s)
    if [ $((now - SP_STARTED)) -gt 60 ]; then
      if ! "$NODE_BIN" sp_health.js >/dev/null 2>&1; then
        echo "[$(date)] screenpipe 不健康(stale/无新帧),杀掉重启" >> "$LOG"
        pkill -9 -f "screenpipe record"; rm -f sp.pid; sleep 2; SP_STARTED=0
      fi
    fi
  fi

  # —— daemon(判断引擎) ——
  ensure daemon.pid "daemon.js" "nohup \"$NODE_BIN\" daemon.js >> daemon.out 2>&1 &" && true
  if ! alive daemon.pid; then echo "[$(date)] 启动 daemon" >> "$LOG"; fi

  # —— electron(悬浮球 UI) ——
  ensure electron.pid "floating-orb/node_modules/electron" "env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --no-sandbox --disable-gpu >> orb_run.log 2>&1 &" && true
  if ! alive electron.pid; then echo "[$(date)] 启动 electron" >> "$LOG"; fi

  sleep 10
done
