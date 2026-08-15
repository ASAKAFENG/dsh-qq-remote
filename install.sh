#!/bin/bash
# dsh-qq-remote 一键安装脚本
# 用法: bash install.sh
# 功能: 构建 → 安装到 DSH profile → 注册 loader 条目 → 生成配置模板
# 环境: DSH_PROFILE 可指定 profile（默认 web）
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

# 1. 构建（生成 lib/ 并链接 @deepseek-ai 运行时依赖）
echo "[1/4] 构建插件…"
bash "$ROOT/scripts/build.sh"

# 2. 安装到 profile 的 node_modules
DEST="$PROFILE_DIR/node_modules/@dsh-external/dsh-qq-remote"
echo "[2/4] 安装到 $DEST"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$ROOT/lib" "$DEST/lib"
if [ -d "$ROOT/node_modules" ]; then
  cp -r "$ROOT/node_modules" "$DEST/node_modules"
fi
cp "$ROOT/package.json" "$DEST/package.json"

# 3. 注册 loader 条目（幂等）
PATCH="$PROFILE_DIR/cordis.patch.yml"
echo "[3/4] 注册 loader 条目…"
if ! grep -q "dsh-qq-remote" "$PATCH" 2>/dev/null; then
  cat >> "$PATCH" <<'EOF'

# dsh-qq-remote（install.sh 添加）
- insert:
    - id: dsh-qq-remote
      name: '@dsh-external/dsh-qq-remote'
      config: {}
EOF
  echo "      已写入 $PATCH"
else
  echo "      patch 已存在，跳过"
fi

# 4. 生成配置模板（如不存在）
CFG="${HOME}/.dsh/qq-remote.json"
echo "[4/4] 配置模板…"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<'EOF'
{
  "wsUrl": "ws://127.0.0.1:3001/ws",
  "allowedUsers": [],
  "groupPrefix": "/",
  "privatePlainAsTask": true,
  "autoReport": true,
  "reportMode": "phase",
  "chatHistoryLimit": 0,
  "chatMaxChars": 0,
  "chatSessionNames": []
}
EOF
  echo "      已生成 $CFG（⚠️ 请把 allowedUsers 改成你的 QQ 号）"
else
  echo "      $CFG 已存在，跳过"
fi

echo "=== 安装完成 ==="
echo "• 重启 DSH 后自动生效（或运行中环境用超级模组 dev_inject_plugin 热加载）"
echo "• 记得配置 ~/.dsh/qq-remote.json 的 allowedUsers 白名单"
echo "• 需要 OneBot 11 服务端（NapCat 等）监听 ws://127.0.0.1:3001/ws"
