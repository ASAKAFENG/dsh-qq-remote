#!/bin/bash
# dsh-qq-remote 卸载脚本
# 用法: bash uninstall.sh
# 功能: 移除 profile patch 条目 + 删除安装目录（保留 ~/.dsh/qq-remote.json 配置与聊天记忆）
# 环境: DSH_PROFILE 指定 profile（默认 web）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${HOME}/.dsh/profiles/${PROFILE}"
PKG_ID='dsh-qq-remote'
PKG_NAME='@dsh-external/dsh-qq-remote'

echo "=== dsh-qq-remote 卸载（profile: ${PROFILE}）==="

# 1. 移除 patch 条目（两遍：删除目标块 → 清理悬挂子行）
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH" ]; then
  python3 - "$PATCH" "$PKG_ID" "$PKG_NAME" <<'PYEOF'
import re, sys, os
path, pkg_id, pkg_name = sys.argv[1], sys.argv[2], sys.argv[3]
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
        out2.append(line)
        last_toplevel = bool(re.match(r'^\s*- (insert:|id:)\s', line))
    else:
        if last_toplevel:
            out2.append(line)

# 空结果 → 还原为顶层 []
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

# 2. 删除安装目录
DEST="$PROFILE_DIR/node_modules/@dsh-external/dsh-qq-remote"
if [ -d "$DEST" ] || [ -L "$DEST" ]; then
  rm -rf "$DEST"
  echo "      已删除 $DEST"
else
  echo "      安装目录不存在（跳过）"
fi

echo "=== 卸载完成 ==="
echo "• 配置 ~/.dsh/qq-remote.json 与聊天记忆（~/.dsh/qq-remote-chats/）已保留，可手动删除"
echo "• 重启 DSH 生效"
