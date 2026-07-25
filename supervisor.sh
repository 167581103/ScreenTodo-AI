#!/bin/bash
# supervisor.sh — 常驻守护:拉起并看护 screenpipe + daemon.js + electron
# 用 Bash 工具的 run_in_background 启动,在桌面会话里常驻,每 ~10s 检查,挂了就重启。
# 对 screenpipe 额外做健康巡检:卡死(stale)或长时间无新帧 → 杀掉重启(自愈)。
# 路径全部可环境变量覆盖:
#   ORB_NODE_BIN  受管 node 路径
#   ORB_SP_BIN    screenpipe 二进制(默认取 PATH 里的 screenpipe)
#   ORB_SP_DATA  screenpipe 数据目录(默认 $PROJ_DIR/.screenpipe)
# 注:WorkBuddy 会给 NODE_OPTIONS 注入 --use-system-ca,electron 二进制拒绝它,故启动 electron 时 -u NODE_OPTIONS。
cd "$(dirname "$0")"
PROJ_DIR="$PWD"
NODE_BIN="${ORB_NODE_BIN:-$(command -v node)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[$(date)] 找不到 Node.js，请设置 ORB_NODE_BIN" >> supervisor.log
  exit 1
fi
SP_BIN="${ORB_SP_BIN:-$(command -v screenpipe 2>/dev/null)}"
# 兜底:屏幕捕获二进制不在 PATH 时,用项目内 node_modules 路径
if [ -z "$SP_BIN" ] || [ ! -x "$SP_BIN" ]; then
  for _cand in "$PROJ_DIR/node_modules/@screenpipe/cli-darwin-arm64/bin/screenpipe" "$PROJ_DIR/node_modules/screenpipe/bin/screenpipe.js" "$PROJ_DIR/node_modules/.bin/screenpipe"; do
    if [ -f "$_cand" ]; then SP_BIN="$_cand"; break; fi
  done
fi
SP_DATA="${ORB_SP_DATA:-$PROJ_DIR/.screenpipe}"
# 从 config.json 读取 Screenpipe API key,注入环境变量,保证自愈重启 screenpipe 后 daemon 仍鉴权通过
SP_KEY=$("$NODE_BIN" -e "try{console.log((require('./config.json').screenpipe||{}).apiKey||'')}catch(e){}" 2>/dev/null)
[ -n "$SP_KEY" ] && export SCREENPIPE_API_KEY="$SP_KEY"
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
  ensure electron.pid "$PROJ_DIR/node_modules/electron" "env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron . --no-sandbox --disable-gpu >> orb_run.log 2>&1 &" && true
  if ! alive electron.pid; then echo "[$(date)] 启动 electron" >> "$LOG"; fi
  sleep 10
done
