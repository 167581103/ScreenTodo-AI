#!/bin/bash
# 停止 screen-orb(UI + 守护进程)
cd "$(dirname "$0")"
PROJ_DIR="$PWD"
pkill -f "$PROJ_DIR/node_modules/electron" 2>/dev/null
pkill -f "$PROJ_DIR/daemon.js" 2>/dev/null
echo "已停止悬浮球与守护进程"
