#!/bin/bash
# 停止 floating-orb(UI + 守护进程)
cd "$(dirname "$0")"
pkill -f "floating-orb/node_modules/electron" 2>/dev/null
pkill -f "floating-orb/daemon.js" 2>/dev/null
echo "已停止悬浮球与守护进程"
