#!/bin/bash
# 启动 screen-orb:先起网络守护进程(daemon.js),再起 UI(electron)
# 关键:
#  1) env -u ELECTRON_RUN_AS_NODE —— 否则 electron 退化成纯 node
#  2) env -u NODE_OPTIONS —— WorkBuddy 注入的 --use-system-ca 会被 electron 二进制拒绝
#  3) --no-sandbox --disable-gpu + 用 dangerouslyDisableSandbox 连真实桌面
#  4) nohup ... & 后必须 disown,否则脚本退出时子进程被回收
cd "$(dirname "$0")"
PROJ_DIR="$PWD"

# 确保 Screenpipe 在跑
if ! curl -s --max-time 4 http://localhost:3030/health >/dev/null 2>&1; then
  echo "⚠️  Screenpipe 未运行,先启动它(需开中文 OCR):"
  echo "   screenpipe record -l chinese &"
  echo "   (可用 ORB_SP_BIN 指定二进制路径;supervisor.sh 会自动拉起)"
  exit 1
fi

# 已在跑就不重复启
if pgrep -f "$PROJ_DIR/node_modules/electron" >/dev/null 2>&1; then
  echo "悬浮球已在运行。先 ./stop.sh 再启动。"
  exit 0
fi

rm -f orb_run.log daemon.out suggestions.jsonl monitor.paused
# 守护进程:网络逻辑,Node 原生 fetch 稳定(用受管 node)
NODE_BIN="${ORB_NODE_BIN:-/Users/apple/.workbuddy/binaries/node/versions/22.22.2/bin/node}"
nohup "$NODE_BIN" daemon.js > daemon.out 2>&1 &
disown

# 悬浮球 UI:只渲染,不碰外网
nohup env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron . --no-sandbox --disable-gpu > orb_run.log 2>&1 &
disown

echo "✅ 悬浮球 + 守护进程已启动。桌面右上角应出现蓝色球。"
echo "   日志: tail -f orb_run.log  daemon.out"
