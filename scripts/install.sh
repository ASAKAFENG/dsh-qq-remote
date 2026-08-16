#!/bin/bash
# dsh-qq-remote 安装脚本（Linux/macOS；Windows 请用 WSL 或 Git Bash）
# 用法: bash install.sh
# 功能: 构建 → 解析依赖版本并安装（自包含）→ 装入 DSH profile → YAML-aware 注册 → 生成配置模板
# 环境: DSH_PROFILE 指定 profile（默认 web）；SKIP_DEPS=1 跳过依赖安装
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${HOME}/.dsh/profiles/${PROFILE}"
PKG_NAME='@dsh-external/dsh-qq-remote'
PKG_ID='dsh-qq-remote'

echo "=== dsh-qq-remote 安装（profile: ${PROFILE}）==="

# 0. 检查 DSH profile
if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误: 找不到 DSH profile 目录 $PROFILE_DIR（可用 DSH_PROFILE 指定）" >&2
  exit 1
fi

# 1. 构建（纯拷贝源码 → lib/，无编译依赖）
echo "[1/5] 构建插件…"
mkdir -p "$ROOT/lib"
cp "$ROOT/index.js" "$ROOT/lib/index.js"
cp "$ROOT/qrgen.js" "$ROOT/lib/qrgen.js"
for m in util.js onebot.js chat.js commands.js panel.js napcat.js; do
  cp "$ROOT/$m" "$ROOT/lib/$m" 2>/dev/null || true
done
if [ -f "$ROOT/client.js" ]; then cp "$ROOT/client.js" "$ROOT/lib/client.js"; fi
for f in index.js qrgen.js util.js onebot.js chat.js commands.js panel.js napcat.js; do
  node --check "$ROOT/lib/$f" || { echo "错误: lib/$f 语法检查失败" >&2; exit 1; }
done
test -f "$ROOT/lib/client.js" || { echo "错误: lib/client.js 缺失（前端 bundle 必需）" >&2; exit 1; }

# 2. 解析依赖实际版本（从当前 DSH 运行时探测，避免猜 npx 缓存/硬编码漂移）
resolve_ver() {
  local pkg="$1"
  for d in "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/"$pkg" \
           "$HOME"/.dsh/profiles/*/node_modules/@deepseek-ai/"$pkg"; do
    if [ -f "$d/package.json" ]; then
      python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$d/package.json" 2>/dev/null && return
    fi
  done
}
TOOLS_VER="$(resolve_ver dsh-tools)";   TOOLS_VER="${TOOLS_VER:-0.1.0-rc.6}"
LLM_VER="$(resolve_ver dsh-llm)";       LLM_VER="${LLM_VER:-0.1.0-rc.6}"
SCHEMA_VER="$(resolve_ver schemastery)"; SCHEMA_VER="${SCHEMA_VER:-3.18.1}"

echo "[2/5] 安装运行时依赖（dsh-tools@${TOOLS_VER} dsh-llm@${LLM_VER} schemastery@${SCHEMA_VER}）…"
if [ "${SKIP_DEPS:-0}" = "1" ] || [ -d "$ROOT/node_modules/@deepseek-ai" ]; then
  echo "      已存在或已跳过"
elif (cd "$ROOT" && npm install --no-audit --no-fund --no-save \
    "@deepseek-ai/dsh-tools@${TOOLS_VER}" \
    "@deepseek-ai/dsh-llm@${LLM_VER}" \
    "@deepseek-ai/schemastery@${SCHEMA_VER}"); then
  echo "      依赖安装完成"
else
  echo "警告: npm 依赖安装失败（可重试或 SKIP_DEPS=1 跳过，宿主 DSH 提供 peer 依赖）" >&2
fi

# 3. 安装到 profile 的 node_modules（tar -ch 解引用复制，不残留符号链接）
DEST="$PROFILE_DIR/node_modules/@dsh-external/dsh-qq-remote"
echo "[3/5] 安装到 $DEST"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -chf - -C "$ROOT" lib | tar -xf - -C "$DEST"
if [ -d "$ROOT/node_modules" ]; then
  tar -chf - -C "$ROOT" node_modules | tar -xf - -C "$DEST"
fi
cp "$ROOT/package.json" "$DEST/package.json"
cp "$ROOT/cordis.patch.yml" "$DEST/cordis.patch.yml"
if [ -f "$ROOT/scripts/repair.sh" ]; then cp "$ROOT/scripts/repair.sh" "$DEST/repair.sh"; fi
test -f "$DEST/lib/client.js" || { echo "错误: 安装后 lib/client.js 不存在" >&2; exit 1; }

# 4. YAML-aware 注册 loader 条目（处理顶层 [] 模板、scoped 引号、原子替换 + 幂等）
PATCH="$PROFILE_DIR/cordis.patch.yml"
echo "[4/5] 注册 loader 条目…"
if [ ! -f "$PATCH" ]; then echo "[]" > "$PATCH"; fi
python3 - "$PATCH" "$PKG_ID" "$PKG_NAME" <<'PYEOF'
import re, sys, os, shutil
path, pkg_id, pkg_name = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
    content = f.read()
# 写前备份（任何意外都可手动回滚）
if content.strip() not in ("", "[]"):
    shutil.copy2(path, path + ".bak-install")
# 清理 1：空 `- insert:` 块（无子列表的顶层条目）
lines = content.split("\n")
cleaned_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    if re.match(r'^\s*- insert:\s*$', line):
        j = i + 1
        # 收集该块后续缩进子行
        sub = []
        while j < len(lines) and (lines[j].strip() == "" or (len(lines[j]) - len(lines[j].lstrip()) > 0)):
            if lines[j].strip() != "":
                sub.append(lines[j])
            j += 1
        if len(sub) == 0:
            i = j  # 空 insert 块：丢弃
            continue
    cleaned_lines.append(line)
    i += 1
content = "\n".join(cleaned_lines)

# 幂等：已存在该 id 的条目块（精确匹配行首，注释/说明不会误命中）
existing = re.search(r'^\s*- id:\s*' + re.escape(pkg_id) + r'\s*$', content, re.M)
# 顶层 [] 模板 / 空文件 → 以列表重建
stripped = content.strip()
if stripped in ("", "[]"):
    content = ""
if existing:
    # 已存在：把清理后的内容写回（修复历史残留）；若条目带 disabled（卸载残留）则重新启用
    content = re.sub(
        r'^(\s*- id:\s*' + re.escape(pkg_id) + r'\s*$\n)(\s*)disabled:\s*true\s*$',
        r'\1',
        content,
        flags=re.M,
    )
    new_content = content
    if new_content != open(path, encoding="utf-8").read():
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new_content)
        os.replace(tmp, path)
    sys.exit(0)
    new_content = content
    if new_content != open(path, encoding="utf-8").read():
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new_content)
        os.replace(tmp, path)
    sys.exit(0)
# 注意：绝不对已有条目做任何"清理/重排"——不同安装方式（NapCat 皮肤、其他插件）的
# 条目结构各不相同，任何重写都可能破坏它们。只做追加。
entry = ("\n- insert:\n"
         "    - id: " + pkg_id + "\n"
         "      name: '" + pkg_name + "'\n"
         "      inject: [webServer, tools]\n"
         "      config: {}\n")
new_content = content.rstrip() + "\n" + entry if content.strip() else entry.lstrip("\n")
# 原子替换（临时文件 + rename，避免写一半）
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(new_content)
os.replace(tmp, path)
print("      已写入 " + path)
PYEOF

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
echo "• 卸载：bash uninstall.sh"
echo "• 记得配置 ~/.dsh/qq-remote.json 的 allowedUsers 白名单"
echo "• 需要 OneBot 11 服务端（NapCat 等）监听 ws://127.0.0.1:3001/ws"
echo
echo "── 当前 profile 插件条目检查 ──"
if command -v python3 >/dev/null 2>&1; then
  if [ -f "$ROOT/scripts/repair.sh" ]; then
    bash "$ROOT/scripts/repair.sh" "$PROFILE" | tail -n +2 | head -20
  else
    echo "（提示：安装目录下的 repair.sh 可诊断 patch 结构完整性）"
  fi
else
  echo "（提示：python3 不可用，跳过检查；建议手动确认其他插件条目完好）"
fi
