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

echo "=== dsh-qq-remote 卸载（profile: ${PROFILE}）==="

# 1. 移除 patch 条目（精确删除该 id 的条目块：- insert: 及其子列表，或裸 - id: 行）
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH" ]; then
  python3 - "$PATCH" "$PKG_ID" <<'PYEOF'
import re, sys, os
path, pkg_id = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    lines = f.readlines()

out = []
i = 0
removed = False
while i < len(lines):
    line = lines[i]
    # 匹配 `- insert:` 块，检查其子列表是否含目标 id
    if re.match(r'^\s*- insert:\s*$', line):
        j = i + 1
        sub = []
        while j < len(lines) and re.match(r'^\s+- ', lines[j]):
            sub.append(lines[j]); j += 1
        if sub and re.search(r'^\s+- id:\s*' + re.escape(pkg_id) + r'\s*$', sub[0], re.M):
            # 删除该块（含前面紧跟的注释行）
            while out and re.match(r'^\s*#', out[-1]):
                out.pop()
            removed = True
            i = j
            continue
        out.append(line)
        out.extend(sub)
        i = j
        continue
    # 匹配裸 `- id: dsh-qq-remote`（disabled 条目等）
    if re.match(r'^\s*- id:\s*' + re.escape(pkg_id) + r'\s*$', line):
        while out and re.match(r'^\s*#', out[-1]):
            out.pop()
        removed = True
        i += 1
        continue
    out.append(line)
    i += 1

# 空结果 → 还原为顶层 []
while out and not out[-1].strip():
    out.pop()
if not any(l.strip() for l in out):
    out = ["[]\n"]

new = "".join(out)
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
