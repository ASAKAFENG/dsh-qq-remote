#!/bin/bash
# Build dsh-qq-remote: 纯 JS 插件（零编译依赖），将 index.js 装配到 lib/，
# 并把 @deepseek-ai 运行时依赖链接到本地 node_modules（与 dsh-tdai-memory 的 vendoring 同理）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Assembling lib/ (index.js + modules + client.js → lib/) ==="
mkdir -p lib
cp index.js lib/index.js
cp qrgen.js lib/qrgen.js
cp util.js onebot.js chat.js commands.js panel.js lib/
cp client.js lib/client.js 2>/dev/null || true
for f in index.js qrgen.js util.js onebot.js chat.js commands.js panel.js client.js; do
  if [ -f "lib/$f" ]; then node --check "lib/$f"; fi
done

# 定位 DSH 运行时 node_modules（npx 缓存）：显式 DSH_APP_NODE_MODULES > 含 dsh-tools 的最新 npx 缓存
APP_NM="${DSH_APP_NODE_MODULES:-}"
if [ -z "$APP_NM" ]; then
  for cand in $(ls -dt "$HOME"/.npm/_npx/*/node_modules 2>/dev/null); do
    if [ -d "$cand/@deepseek-ai/dsh-tools" ]; then APP_NM="$cand"; break; fi
  done
fi
if [ -z "$APP_NM" ] || [ ! -d "$APP_NM/@deepseek-ai" ]; then
  echo "build: 无法定位 DSH 运行时 node_modules（可设置 DSH_APP_NODE_MODULES）" >&2
  exit 1
fi

link_pkg() {
  local name="$1"
  local target="$APP_NM/$name"
  if [ ! -e "$target" ]; then
    echo "build: 缺少依赖目标: $target" >&2
    exit 1
  fi
  mkdir -p "node_modules/$(dirname "$name")"
  rm -rf "node_modules/$name"
  ln -sfn "$(realpath "$target")" "node_modules/$name"
  echo "link: node_modules/$name -> $target"
}

echo "=== Linking runtime dependencies (app node_modules: $APP_NM) ==="
link_pkg @deepseek-ai/dsh-tools
link_pkg @deepseek-ai/dsh-llm
link_pkg @deepseek-ai/schemastery

echo "=== Build complete (lib/index.js) ==="
