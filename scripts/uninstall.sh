#!/bin/bash
# dsh-qq-remote 卸载脚本（彻底卸载）
# 用法: bash uninstall.sh [--purge]
#   --purge  连配置 ~/.dsh/qq-remote.json 与聊天记忆 ~/.dsh/qq-remote-chats/ 一起删除
# 功能: 移除 profile patch 条目 → 删除安装目录（含 junction）→ 清理注入器 registry
#       → 检查 profile package.json 残留 → （--purge 删配置/聊天记录）
# 环境: DSH_PROFILE 指定 profile（默认 web）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${HOME}/.dsh/profiles/${PROFILE}"
PKG_ID='dsh-qq-remote'
PKG_NAME='@dsh-external/dsh-qq-remote'
PURGE=""
[ "${1:-}" = "--purge" ] && PURGE=1

echo "=== dsh-qq-remote 卸载（profile: ${PROFILE}${PURGE:+, --purge 全清}）==="

# 1. 移除 patch 条目（两遍：删除目标块 → 清理悬挂子行）
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH" ]; then
  python3 - "$PATCH" "$PKG_ID" <<'PYEOF'
import re, sys, os
path, pkg_id = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    lines = f.readlines()

def indent_of(line):
    return len(line) - len(line.lstrip())

def block_end(i):
    base = indent_of(lines[i])
    j = i + 1
    while j < len(lines):
        if not lines[j].strip():
            j += 1
            continue
        if indent_of(lines[j]) <= base:
            break
        j += 1
    return j

def is_target_id(line):
    return re.match(r'^\s*- id:\s*' + re.escape(pkg_id) + r'\s*$', line)

# 第一遍：删除目标条目块（- insert: 包裹块 / 裸 - id: 块）
out = []
removed = False
i = 0
while i < len(lines):
    line = lines[i]
    if re.match(r'^\s*- insert:\s*$', line):
        j = block_end(i)
        block = lines[i:j]
        if any(re.match(r'^\s+- id:\s*' + re.escape(pkg_id) + r'\s*$', l) for l in block):
            while out and re.match(r'^\s*#', out[-1]):
                out.pop()
            removed = True
            i = j
            continue
        out.extend(block)
        i = j
        continue
    if is_target_id(line):
        j = block_end(i)
        while out and re.match(r'^\s*#', out[-1]):
            out.pop()
        removed = True
        i = j
        continue
    out.append(line)
    i += 1

# 第二遍：清理悬挂子行（父块已被删的 name:/config: 等残留）
out2 = []
last_toplevel = False
for line in out:
    if not line.strip():
        out2.append(line)
        continue
    if indent_of(line) == 0:
        if line.strip() == "[]":
            continue
        out2.append(line)
        last_toplevel = bool(re.match(r'^\s*- (insert:|id:)\s', line))
    else:
        if last_toplevel:
            out2.append(line)

if not any(l.strip() for l in out2):
    out2 = ["[]\n"]

new = "".join(out2)
if new != "".join(lines):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(new)
    os.replace(tmp, path)
print(("      已移除条目 " + pkg_id) if removed else "      未发现条目（跳过）")
PYEOF
fi

# 2. 删除安装目录（含 junction/symlink：rm -rf 只删链接本身，不伤目标）
DEST="$PROFILE_DIR/node_modules/@dsh-external/dsh-qq-remote"
if [ -d "$DEST" ] || [ -L "$DEST" ]; then
  rm -rf "$DEST"
  echo "      已删除 $DEST"
else
  echo "      安装目录不存在（跳过）"
fi

# 3. 清理超级模组注入器 registry（否则 DSH 重启后自动恢复注入，等于没卸载）
REG="${HOME}/.dsh/super-injector/registry.json"
if [ -f "$REG" ]; then
  python3 - "$REG" "$PKG_NAME" <<'PYEOF2'
import json, sys, os
path, pkg_name = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(data, list):
    sys.exit(0)
before = len(data)
data = [e for e in data if not (isinstance(e, dict) and e.get("name") == pkg_name)]
if len(data) != before:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    print("      已清理注入器 registry 条目")
PYEOF2
fi

# 4. 检查 profile package.json 是否有 bundles / dependencies 残留（官方 dsh plugin 安装路径）
PKG_JSON="$PROFILE_DIR/package.json"
if [ -f "$PKG_JSON" ]; then
  python3 - "$PKG_JSON" "$PKG_NAME" <<'PYEOF3'
import json, sys, os
path, pkg_name = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
changed = False
for key in ("dependencies", "devDependencies"):
    if isinstance(d.get(key), dict) and d[key].pop(pkg_name, None) is not None:
        changed = True
if isinstance(d.get("bundles"), list):
    b = [x for x in d["bundles"] if x != pkg_name]
    if len(b) != len(d["bundles"]):
        d["bundles"] = b
        changed = True
if changed:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    print("      已清理 profile package.json 残留（dependencies/bundles）")
PYEOF3
fi

# 5. --purge：删配置与聊天记忆
CFG="${HOME}/.dsh/qq-remote.json"
CHATS="${HOME}/.dsh/qq-remote-chats"
if [ "$PURGE" = "1" ]; then
  [ -f "$CFG" ] && rm -f "$CFG" && echo "      已删除配置 $CFG"
  [ -d "$CHATS" ] && rm -rf "$CHATS" && echo "      已删除聊天记忆 $CHATS"
  echo "=== 卸载完成（全清）==="
  echo "• 配置与聊天记忆已删除；重启 DSH 生效"
else
  echo "=== 卸载完成 ==="
  echo "• 配置 $CFG 与聊天记忆 $CHATS 已保留"
  echo "  如需一并删除请运行: bash scripts/uninstall.sh --purge"
  echo "• 重启 DSH 生效"
fi
