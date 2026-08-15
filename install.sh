#!/bin/bash
# dsh-qq-remote 一键安装脚本（跨平台）
# 用法: bash install.sh
# 功能: 构建 → 安装依赖（npm，自包含）→ 装入 DSH profile → 注册 loader → 生成配置模板
# 环境: DSH_PROFILE 可指定 profile（默认 web）；跳过依赖安装用 SKIP_DEPS=1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${HOME}/.dsh/profiles/${PROFILE}"

echo "=== dsh-qq-remote 一键安装（profile: ${PROFILE}）==="

# 0. 检查 DSH profile
if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误: 找不到 DSH profile 目录 $PROFILE_DIR（可用 DSH_PROFILE 指定）" >&2
  exit 1
fi

# 1. 构建（纯拷贝 index.js/client.js → lib/，无编译依赖）
echo "[1/5] 构建插件…"
mkdir -p "$ROOT/lib"
cp "$ROOT/index.js" "$ROOT/lib/index.js"
if [ -f "$ROOT/client.js" ]; then cp "$ROOT/client.js" "$ROOT/lib/client.js"; fi
node --check "$ROOT/lib/index.js"

# 2. 安装运行时依赖（自包含，不依赖宿主机位置；离线/已有依赖可 SKIP_DEPS=1 跳过）
echo "[2/5] 安装运行时依赖（npm）…"
if [ "${SKIP_DEPS:-0}" = "1" ] || [ -d "$ROOT/node_modules/@deepseek-ai" ]; then
  echo "      已存在或已跳过"
elif (cd "$ROOT" && npm install --no-audit --no-fund --no-save \
    "@deepseek-ai/dsh-tools@0.1.0-rc.6" \
    "@deepseek-ai/dsh-llm@0.1.0-rc.6" \
    "@deepseek-ai/schemastery@3.18.1"); then
  echo "      依赖安装完成"
else
  echo "警告: npm 依赖安装失败（可重试或 SKIP_DEPS=1 跳过，宿主 DSH 提供 peer 依赖）" >&2
fi

# 3. 安装到 profile 的 node_modules（符号链接解引用复制，保证目标可用）
DEST="$PROFILE_DIR/node_modules/@dsh-external/dsh-qq-remote"
echo "[3/5] 安装到 $DEST"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
# tar -ch 解引用复制（符号链接复制为真实文件，目标机不依赖任何绝对路径）
tar -chf - -C "$ROOT" lib | tar -xf - -C "$DEST"
if [ -d "$ROOT/node_modules" ]; then
  tar -chf - -C "$ROOT" node_modules | tar -xf - -C "$DEST"
fi
cp "$ROOT/package.json" "$DEST/package.json"

# 4. 注册 loader 条目（幂等）
PATCH="$PROFILE_DIR/cordis.patch.yml"
echo "[4/5] 注册 loader 条目…"
if ! grep -q "dsh-qq-remote" "$PATCH" 2>/dev/null; then
  cat >> "$PATCH" <<'PATCHEOF'

# dsh-qq-remote（install.sh 添加）
- insert:
    - id: dsh-qq-remote
      name: '@dsh-external/dsh-qq-remote'
      config: {}
PATCHEOF
  echo "      已写入 $PATCH"
else
  echo "      patch 已存在，跳过"
fi

# 5. 生成配置模板（如不存在）
CFG="${HOME}/.dsh/qq-remote.json"
echo "[5/5] 配置模板…"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<'CFGEOF'
{
  "wsUrl": "ws://127.0.0.1:3001/ws",
  "allowedUsers": [],
  "groupPrefix": "/",
  "privatePlainAsTask": true,
  "autoReport": true,
  "reportMode": "phase",
  "chatHistoryLimit": 0,
  "chatMaxChars": 0,
  "chatSessionNames": [],
  "qrcodePath": "",
  "napcatServiceName": "napcat-qq"
}
CFGEOF
  echo "      已生成 $CFG（⚠️ 请把 allowedUsers 改成你的 QQ 号）"
else
  echo "      $CFG 已存在，跳过"
fi

echo "=== 安装完成 ==="
echo "• 重启 DSH 后自动生效（或运行中环境用超级模组 dev_inject_plugin 热加载）"
echo "• 记得配置 ~/.dsh/qq-remote.json 的 allowedUsers 白名单"
echo "• 需要 OneBot 11 服务端（NapCat 等）监听 ws://127.0.0.1:3001/ws"
echo "• 依赖为自包含（npm 安装），不依赖宿主 DSH 的安装位置"
