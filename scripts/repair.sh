#!/bin/bash
# dsh-qq-remote 诊断修复工具（只读，不改任何文件）
# 用法: bash repair.sh [profile]
# 功能: 检查 profile 的 cordis.patch.yml 结构完整性，列出所有插件条目，
#       检测旧版 install.sh 可能造成的条目破坏，并给出恢复建议。
# 环境: DSH_PROFILE 指定 profile（默认 web）
set -uo pipefail

PROFILE="${DSH_PROFILE:-${1:-web}}"
PROFILE_DIR="${HOME}/.dsh/profiles/${PROFILE}"
PATCH="$PROFILE_DIR/cordis.patch.yml"

echo "=== dsh-qq-remote 诊断（profile: ${PROFILE}）==="

if [ ! -f "$PATCH" ]; then
  echo "ℹ️  $PATCH 不存在 —— patch 文件从未创建或已被删除。"
  echo "   若皮肤/其他插件是通过此文件装配的，它们也会失效。"
  exit 0
fi

echo "📄 $PATCH"
echo

python3 - "$PATCH" <<'PYEOF'
import re, sys, os
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    lines = f.read().split("\n")

entries = []      # (line_no, id, name, disabled, indented_children)
cur = None
problems = []

for idx, line in enumerate(lines, 1):
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        continue
    ind = len(line) - len(line.lstrip())

    m_id = re.match(r'^- id:\s*(\S+)\s*$', stripped)
    m_ins = re.match(r'^- insert:\s*$', stripped)
    m_name = re.match(r'^\s*- name:\s*(.+)$', stripped)  # 皮肤类条目可能用 - name: 顶层
    m_insert_inline = re.match(r'^- insert:\s*\{', stripped)

    if m_id:
        if cur is not None and cur["children"] == 0:
            problems.append(f"第 {cur['line']} 行条目 `{cur['id']}` 没有子行（残缺：name/inject 等被删）")
        cur = {"line": idx, "id": m_id.group(1), "name": None, "disabled": False, "children": 0}
        entries.append(cur)
    elif m_ins or m_insert_inline:
        cur = None
    elif cur is not None:
        if stripped.startswith("name:"):
            cur["name"] = stripped.split(":", 1)[1].strip().strip("'\"")
        if stripped.startswith("disabled:"):
            cur["disabled"] = "true" in stripped
        if ind > 0:
            cur["children"] += 1
    elif stripped.startswith("name:") or stripped.startswith("inject:"):
        problems.append(f"第 {idx} 行：孤立的 `{stripped.split(':')[0]}:` 行（父条目已丢失）")

if cur is not None and cur["children"] == 0:
    problems.append(f"第 {cur['line']} 行条目 `{cur['id']}` 没有子行（残缺：name/inject 等被删）")

# 输出条目清单
print("当前 patch 中的插件条目：")
if not entries:
    print("  （无任何条目 —— 文件为空或被清空）")
for e in entries:
    flag = " ⚠️ disabled" if e["disabled"] else ""
    print(f"  • {e['id']}{flag}" + (f"  →  {e['name']}" if e["name"] else ""))

# 输出问题
if problems:
    print()
    print("⚠️  检测到疑似被旧版 install.sh 破坏的残缺结构：")
    for p in problems:
        print(f"  - {p}")
else:
    print()
    print("✅ 未发现残缺结构（所有条目结构完整）")

# 皮肤类条目检查
skin_ids = [e for e in entries if re.search(r'skin|ui|maid|theme|atelier', e["id"], re.I)]
if not skin_ids:
    print()
    print("ℹ️  未发现皮肤/UI 类条目。若你的皮肤插件曾通过本文件装配，")
    print("   它可能已被旧版 install.sh 删除 —— 需要重新安装皮肤插件。")

# 备份提示
for bak in (path + ".bak-install", path + ".bak-writepatch"):
    if os.path.exists(bak):
        print()
        print(f"💾 发现备份文件 {os.path.basename(bak)}（{os.path.getsize(bak)} 字节）")
        print(f"   若确认当前文件被破坏，可手动恢复：")
        print(f"     cp \"{bak}\" \"{path}\"")
        break
PYEOF

echo
echo "=== 诊断完成 ==="
echo "• 若皮肤条目缺失：重新安装皮肤插件（或从上方备份恢复）"
echo "• 若条目在但皮肤不生效：检查 DSH 启动日志中皮肤插件的报错"
