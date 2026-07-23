#!/bin/bash
# 停止 screen-orb(UI + 守护进程)
cd "$(dirname "$0")"
PROJ_DIR="$PWD"

stop_pidfile() {
  local file="$1"
  if [ -f "$file" ]; then
    local pid
    pid=$(cat "$file" 2>/dev/null)
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    rm -f "$file"
  fi
}

# supervisor 以相对路径启动 daemon.js，单靠绝对路径 pkill 匹配不到；优先使用 pidfile。
stop_pidfile electron.pid
stop_pidfile daemon.pid
stop_pidfile daemon.lock

# 兜底清理由本项目 Electron 二进制派生出的主进程。
pkill -f "$PROJ_DIR/node_modules/electron" 2>/dev/null
echo "已停止悬浮球与守护进程"
