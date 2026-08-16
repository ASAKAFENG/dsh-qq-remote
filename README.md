# dsh-qq-remote — 用 QQ 远程控制你的 DeepSeek Harness

> ## ⚠️⚠️ 安全警告（必读）⚠️⚠️
>
> 本插件可以通过 QQ **远程执行命令、截图、查看文件**——权限很大，请务必注意：
>
> 1. **必须配置白名单**：`allowedUsers` 留空 = **任何 QQ 号都能控制你的电脑**。
>    安装后第一件事：在 DSH 设置页「QQ 远程」面板的**控制白名单**里添加你自己的 QQ 号（或编辑 `~/.dsh/qq-remote.json` 的 `allowedUsers`）。
> 2. **强烈建议使用小号**：机器人 QQ 请用**小号 / 专用机器人号**，不要用日常主号。
>    QQ 机器人框架（NapCat 等）存在**被风控甚至封号**的风险；且插件权限极大，小号出问题不会影响你的主号与账号资产。

装上这个插件，你的 QQ 就能变成 DSH 的遥控器：出门在外用手机发条消息就能让电脑干活 —— 派任务、跑命令、看进度、收截图；想聊天时它又能变成陪你闲聊的 AI 搭子。登录失效不用折腾命令行，打开设置面板扫码即恢复。

> ⚠️ **前置依赖（必装）**：本插件**不包含 QQ 协议实现**，需要先安装并运行 **NapCat**（或 Lagrange.OneBot / go-cqhttp / LLOneBot 等 OneBot 11 实现）作为 QQ 桥。NapCat 未运行时插件无法收发 QQ 消息，面板会显示"NapCat 未启动"。
>
> **NapCat 与插件联动三步**：
> 1. 安装 NapCat（Linux：https://im.qq.com/linuxqq 装 QQ 后用 NapCat 官方脚本注入，或用 NapCat.Shell；Windows/macOS 用官方安装包），启动并**手机扫码登录**机器人 QQ
> 2. 打开 NapCat WebUI（默认 `http://127.0.0.1:6099/webui`）→ 网络配置 → 新增 **WebSocket 服务端**：监听 `127.0.0.1:3001`（路径 `/ws`，消息格式 array）——与插件默认 `wsUrl` 一致
> 3. 启动 DSH + 插件后，DSH 设置页「QQ 远程」面板会显示"已连接"；若 NapCat 登录失效，面板可直接扫码恢复

> 💡 **安装提示**：直接把这个仓库链接发给你的 AI 编程助手（Codex、Claude Code 等），它能按本 README 自行完成安装与配置。



## 功能

| 能力 | 命令 / 工具 | 说明 |
| --- | --- | --- |
| 执行命令 | `/exec <shell>` | 在电脑上执行 shell 命令并回传输出（可配置超时/工作目录） |
| 派发任务 | `/ask <任务>`（私聊直接发消息也行） | 注入当前 DSH agent 会话，agent 开始执行 |
| 查看进度 | `/status` `/progress [n]` | agent 状态 / 最近进度事件回放 |
| 阶段汇报 | 自动 | phase 模式：轮次小结/完成总结/出错即时/长任务心跳，不刷屏 |
| 会话管理 | `/sessions` `/session <序号\|标题\|id>` `/title` | 标题化会话列表、按序号/标题/ID 切换、重命名 |
| 新建会话 | `/newsession <id>` | 在当前工作区新建 agent 会话并切换（生命周期挂 DSH 根进程） |
| AI 聊天 | `/chat on\|off` `/chat <名字>` | 纯净聊天模式：直连模型像人一样回复，多聊天会话、记忆持久化 |
| 聊天特化会话 | `/chatbind on\|off` | 把指定 DSH 会话绑定为聊天特化：发消息=直接聊天（角色可自定义），其他会话不受影响 |
| 取消任务 | `/cancel` | 中止 agent 当前工作 |
| 截图回传 | `/screenshot` | 截屏（xdg-desktop-portal / grim / scrot…）并以图片消息发送 |
| Agent 主动汇报 | `qq_report` `qq_screenshot` | agent 在会话里可主动向 QQ 发送文本 / 截图 |
| QQ 图形开关 | `/panel` + 设置页「QQ 远程」 | 实时状态、一键重新登录、登录失效自动弹出二维码扫码恢复 |
| 一键安装 | `scripts/install.sh` | 自动构建 + npm 依赖 + 装配注册，跨平台自包含 |

## 命令一览

| 命令 | 说明 | 缩写 |
| --- | --- | --- |
| `/help` | 查看全部命令（含缩写对照） | `/h` |
| `/ping` | 连通性测试 | `/pong` |
| `/status` | 查看 agent 状态 | `/st` |
| `/sessions` | 列出会话（标题+ID+状态） | `/ss` |
| `/session <序号\|标题\|id>` | 切换目标会话 | `/s` |
| `/title <名称>` | 给当前目标会话重命名 | `/rename` |
| `/newsession <id>` | 新建会话并切换 | `/ns` |
| `/ask <任务>` | 派发任务（私聊直接发消息也行） | `/task` |
| `/cancel` | 取消当前任务 | `/x` |
| `/exec <命令>` | 在电脑上执行 shell 命令 | `/run` |
| `/progress [n]` | 查看最近进度 | `/pg` |
| `/screenshot` | 截图并发送给你 | `/sc` |
| `/quiet on\|off` | 开关进度自动推送 | `/q` |
| `/chat on\|off` | 纯净聊天模式（`/chat <名字>` 切换会话） | — |
| `/chatbind on\|off` | 聊天特化会话（直接聊天） | `/cb` |
| `/panel` | 打开 QQ 控制面板 | `/pn` |

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22（使用内置 WebSocket / fetch，零 npm 依赖） |
| 宿主 | DeepSeek Harness（DSH）环境，提供 `@deepseek-ai/*` peer 依赖 |
| QQ 桥 | 任一 OneBot 11 实现（NapCat / Lagrange.OneBot / go-cqhttp / LLOneBot） |
| 平台 | Linux 完整支持；macOS / Windows 核心功能可用（见下） |

**平台支持情况：**
- ✅ **已在 Ubuntu 环境验证安装通过**（一键安装脚本、插件市场 cordis-plugin 安装管线、与 NapCat 联动、扫码登录全链路均实测可用）


## 安装与配置

### 一键安装（推荐，开源用户）

```bash
git clone https://github.com/ASAKAFENG/dsh-qq-remote
cd dsh-qq-remote
bash scripts/install.sh
```

自动完成：构建 → 安装到 DSH profile → 注册 loader 条目 → 生成配置模板（`~/.dsh/qq-remote.json`），重启 DSH 生效。

### 手动安装

1. 构建：`bash scripts/build.sh`（纯 JS，无编译依赖）
2. 注入：DSH 侧 `dev_inject_plugin`（或 loader 装配），插件名 `@dsh-external/dsh-qq-remote`
3. 运行任一 OneBot 11 实现（如 NapCat），开启**反向 WebSocket**（默认 `ws://127.0.0.1:3001/ws`），
   路径与插件 `wsUrl` 保持一致；配置了 token 时 WS 走 `?access_token=`、HTTP 走 `Authorization: Bearer`

配置有两种方式：插件 Config（loader 注入时传入）或覆盖层文件 `~/.dsh/qq-remote.json`
（免改代码、即时生效，热重载后应用）：

```json
{
  "wsUrl": "ws://127.0.0.1:3001/ws",
  "allowedUsers": [123456789],
  "groupPrefix": "/",
  "privatePlainAsTask": true,
  "autoReport": true,
  "reportMode": "phase",
  "chatSystemPrompt": "你是用户通过 QQ 联系的一位聊天伙伴。回复要像真人 QQ 聊天一样：简短自然、口语化、有来有回，不要使用列表/表格/标题等正式格式，不要提及你是 AI、模型或助手。",
  "chatHistoryLimit": 0,
  "chatMaxChars": 0,
  "chatSessionNames": []
}
```

> 说明：`chatSystemPrompt` 是聊天模式的人设提示词，默认只约束"像真人聊天"的回复格式，**可自由替换成任何角色**（如 AI 女友、助理、猫娘…）；
> `chatHistoryLimit` / `chatMaxChars` 为 `0` 表示上下文无限制（全量发送）；
> `chatSessionNames` 由 `/chatbind` 命令自动维护，一般无需手改。

完整配置项见 `USAGE.md`（含 `reportMode`/`phaseIntervalMs`/`chatSessionNames` 等全部字段）。


## 快速上手

1. **配置白名单**：通过设置里面的 QQ远程 来配置 或者 `~/.dsh/qq-remote.json`，把 `allowedUsers` 改成你的 QQ 号（默认示例 `[123456789]` 会放行任意消息，务必替换）
2. **重启 DSH** 让插件加载生效（或热重载）
3. **确保 NapCat 已安装并运行**（前置依赖，见文首"NapCat 与插件联动三步"）：NapCat WebUI 里配好 `127.0.0.1:3001` 的 WebSocket 服务端并已扫码登录机器人 QQ
4. **验证打通**：DSH 设置页「QQ 远程」面板显示"已连接"，用你的 QQ 号给机器人发 `/ping` → 回复 `pong` 即成功；发 `/help` 查看全部命令
5. **登录失效恢复**：面板出现二维码后用手机 QQ 扫码授权（2 分钟有效，自动刷新；扫码是 QQ 安全机制，无法跳过）
6. **常用命令**：

| 想做什么 | 发什么 |
| --- | --- |
| 派发任务 | `/ask 帮我整理桌面文件`（或私聊直接发消息） |
| 查看进度 | `/status` / `/progress` |
| 截图看屏幕 | `/screenshot` |
| 执行命令 | `/exec ls -la` |
| AI 聊天 | `/chat on`（`/chat off` 退出） |
| 会话管理 | `/sessions` / `/session <标题或id>` / `/title 新名字` |
| 控制面板 | `/panel`（或设置页「QQ 远程」） |

> 💡 进度会自动推送到 QQ（`/quiet off` 可关）；设置页可增删控制白名单；`uninstall.sh --purge` 可彻底卸载。

## 截图原理

优先调用 xdg-desktop-portal 的 `Screenshot`（GNOME Wayland 非交互截屏，无需额外安装）；
失败则依次尝试自定义 `screenshotCommand`、`grim`、`scrot`、`maim`、`import`、`gnome-screenshot`。

## 测试

`test/onebot-mock.mjs` 是一个本地 OneBot 模拟服务端，用于无 QQ 环境下的端到端验证：

```bash
cd test && npm i        # 安装 ws（仅测试依赖）
node test/onebot-mock.mjs 3001
# 另一个终端：node test/onebot-mock.mjs 的 stdin 输入:
#   msg 123456 /exec echo hello
#   msg 123456 /screenshot
```

## 安全提示

- `allowedUsers` 务必配置为你的 QQ 号，否则任何给你机器人发消息的人都能控制电脑
- `/exec` 可执行任意命令；`execAllowed: false` 可整体禁用
- 建议通过 NapCat 使用小号/机器人号，避免主号被风控


## 更新日志

### v1.0.0（2026-08-16）—— 🎉 正式版

- ✅ **已彻底完成全流程验证**：Ubuntu 环境安装（一键脚本 / 插件市场 cordis-plugin 管线）→ 前置 NapCat 部署与联动（WebUI 配置 3001 WebSocket 服务端）→ OneBot 连接 → QQ 扫码登录 → 命令执行 / 任务派发 / 进度推送 / 截图回传 / AI 聊天 / 会话管理 / 白名单 / 二维码失效自动刷新与扫码恢复 —— 全链路实测通过
- 🎯 **本版本作为正式版本（1.0.0）**，后续功能迭代将在 1.x 上继续


### v0.3.16（2026-08-16）—— 清理引导残留文案

- 🧹 全面清理移除一键引导后的残留：panel.js 注释/头部描述、设置面板与完整面板的"一键安装/启动 NapCat"提示文案（改为指向 README 前置依赖）、README 遗留 FAQ 行
- 🔧 relogin/诊断提示统一指向"README 前置依赖 + WebUI 3001 配置"


### v0.3.15（2026-08-16）—— 移除一键引导，回归"前置依赖 NapCat"模式

- 🗑️ **移除一键引导功能**：不再自动下载/安装/配置 NapCat（引导模块 `napcat.js` 及面板按钮、下载源、机器人 QQ 号输入全部移除）——插件回归纯远程控制职责，NapCat 由用户自行安装（README 摘要给出前置依赖提醒与联动三步）
- 📖 README 摘要新增 **"前置依赖（必装）"** 提醒：NapCat 与插件联动三步（装 NapCat + 扫码 → WebUI 配 3001 WebSocket 服务端 → 面板显示已连接）
- 🧹 代码精简：移除 napcat.js 模块（约 400 行）、3 个配置项、4 个面板路由、引导 UI 区块
- 🧪 e2e 精简为 17 用例（保留诊断/二维码/消息链路）


### v0.3.14（2026-08-16）—— 修复 launcher 引导：NAPCAT_BOOTMAIN 层级错误

- 🐛 **根因**：launcher 的 `loadNapCat.js` 加载 `${NAPCAT_BOOTMAIN}/napcat.mjs`，但服务把 `NAPCAT_BOOTMAIN` 指向了 launcher 目录（`~/.dsh/napcat-linux`）——实际 `napcat.mjs` 在 `napcat/` 子目录（符号链接）里 → `ERR_MODULE_NOT_FOUND`
- 🔧 **修复**：`NAPCAT_BOOTMAIN` 与 `WorkingDirectory` 直接指向 NapCat 实际根目录（`~/.dsh/napcat`），`LD_PRELOAD` 仍指向 launcher 的 so
- 🧪 e2e 扩至 26 用例（BOOTMAIN/WorkingDirectory 指向安装目录）


### v0.3.13（2026-08-16）—— 二维码过期自动刷新（不再显示死码）

- 🐛 **根因**：二维码约 2 分钟有效，但插件 10 分钟内都视为"新鲜"——过期旧码一直显示，扫码提示失效
- 🔧 **新鲜窗口收紧**：文件模式 10 分钟 → 3 分钟；过期时自动调用 NapCat WebUI `RefreshQRcode` 强制换新码
- 🔧 **死码清理**：连续 6 分钟未更新的二维码文件自动删除（UI 明确进入等待，NapCat 刷新后重写）
- 🔧 **WebUI URL 陈旧检测**：取到的二维码 URL 超过 2.5 分钟自动 Refresh 重取（不再长期显示内存缓存的旧码）
- 🔧 修复 status 400（findStaleQrcode 作用域错误）
- 🧪 e2e 25 用例保持全过


### v0.3.12（2026-08-16）—— Linux 引导修复：NapCat 经 launcher 注入 QQ 宿主

- 🐛 **根因**：NapCat.Shell 在 Linux 上不是独立程序，`node napcat.mjs` 直启会失败（`--no-sandbox` 传给 node / 找不到 QQ 资源）
- 🔧 **Linux launcher 模式**：引导自动下载官方预编译 `libnapcat_launcher.so`（按架构）→ 建立 `~/.dsh/napcat-linux/`（含 napcat 符号链接）→ 服务改为 `LD_PRELOAD=launcher /opt/QQ/qq --no-sandbox` + `NAPCAT_BOOTMAIN`
- ✨ **Linux 下无需填写 QQ 号**：QQ 内核随宿主启动即进入登录流程，二维码直接生成
- ❌ 找不到 Linux QQ（/opt/QQ/qq）时明确报错并提示安装（不再用 node 硬启）
- 🧪 e2e 扩至 25 用例（launcher 模板/宿主/LD_PRELOAD）


### v0.3.11（2026-08-16）—— 修复 QQ 号保存失效

- 🐛 **根因**：设置页保存按钮在镜像列表未加载完时，URL 计算出空值直接 return——**QQ 号根本没提交**（静默丢弃）
- 🔧 **修复**：URL 为空时回退到服务端当前值；QQ 号始终随保存提交；后端空 URL 不再报错（仅保存 QQ 号）
- 🔍 **引导验证步骤**：引导完成后输出服务实际 ExecStart 命令（一眼确认 `-q <QQ号>` 是否写入）


### v0.3.10（2026-08-16）—— 白名单保存失败提示 + 引导可重复应用

- 🔧 **白名单保存不再静默失败**：写入 `~/.dsh/qq-remote.json` 失败时前端显示真实错误（此前显示"已保存"但刷新后丢失）
- 🔧 **引导按钮常驻**：未登录时始终显示「NapCat 引导」区块（QQ 号/下载源/引导按钮），服务已启动时按钮变为「重新应用 NapCat 服务（修复）」
- 🔧 **服务可重写**：引导发现托管服务（dsh-napcat.service）的 unit 与期望不一致（如补上 `-q QQ号`）时自动重写并重启——填了 QQ 号后重新引导即可生效，无需手动改服务


### v0.3.9（2026-08-16）—— 修复引导后无二维码（NapCat 需要 -q 登录）

- 🔧 **根因**：NapCat.Shell 不带 `-q <QQ号>` 启动时只跑 WebUI 模式，不会生成登录二维码
- ✨ **设置面板新增「机器人 QQ 号」输入**：引导安装时自动写入服务启动参数 `-q <QQ号>`（快速登录/二维码），保存到 `~/.dsh/qq-remote.json`（`napcatQQ`）
- 🧭 **探测路径补全**：WebUI 配置与二维码文件探测加入引导安装目录 `~/.dsh/napcat`（此前引导装到哪就探测不到哪）
- 🔔 未配置 QQ 号时引导会明确提示"请填写机器人 QQ 号后重新引导"


### v0.3.6（2026-08-16）—— 设置面板可配置 NapCat 下载源

- ⬇️ **下载源可选项**：设置页「QQ 远程」面板新增「NapCat 下载源」—— 官方 GitHub / gh-proxy.com 镜像 / ghfast.top 镜像 / 自定义地址，一键切换并保存（写入 `~/.dsh/qq-remote.json` 即时生效）
- 🔧 后端 `GET/POST /qq-remote/napcat/settings`：镜像列表单一事实源，支持自定义 URL 校验（http/https/file）
- 🧪 e2e 21 用例保持全过


### v0.3.5（2026-08-16）—— 引导下载体验：实时进度 + 镜像支持

- ⚡ **实时下载进度**：引导面板显示「下载中 xMB / 29MB（x%）」，不再干等
- ⏱️ **下载超时放宽**：5 分钟 → 15 分钟（慢网络友好）
- 🔗 **可配置下载源**：新增 `napcatDownloadUrl`（默认官方 GitHub Release，可换镜像或本地文件路径）；手动预下载 `~/.dsh/NapCat.Shell.zip` 自动跳过下载
- 🧪 e2e 21 用例保持全过


### v0.3.4（2026-08-16）—— 修复"一键安装 NapCat"按钮消失

- 🐛 **按钮消失根因**：NapCat 的 systemd unit 存在但未运行（inactive，如引导注册过服务或残留 unit）时，被误判为"服务存在"→ 二维码原因变成 `webui_not_found`/`waiting` → 引导按钮隐藏
- 🔧 **修正语义**：`napcat_not_running` 现在严格按"服务**正在运行**"判断（unit 不存在或 inactive 都显示引导按钮）；`/qq-remote/status` 新增 `napcatActive` 字段区分"服务存在"与"正在运行"
- ❌ relogin 同步：服务 inactive 时也返回真实错误（含修复指引）
- 🧪 e2e 扩至 20 用例（含"unit 存在但 inactive → 显示引导按钮"场景）


### v0.3.3（2026-08-16）—— 引导修复：dirname bug + 防双实例顶号

- 🐛 **修复引导崩溃**：`Cannot read properties of undefined (reading 'dirname')` —— `os.path.dirname` 误用修正为 `path.dirname`
- 🛡️ **防双实例顶号**：bootstrap 前检查已有活跃 NapCat 服务 / OneBot 连接，存在则跳过并提示（不再出现"两个 NapCat 抢同一 QQ 账号互相顶下线"）
- 🔒 **安装目录排他**：配置 `napcatInstallDir` 时只信任配置值，不再扫描其他候选
- 🧪 e2e 扩至 19 用例（防顶号跳过、下载失败结构化错误路径）


### v0.3.2（2026-08-16）—— 开箱即用：NapCat 引导 + 二维码诊断

- 🧩 **一键安装 NapCat**：面板新增「一键安装/启动 NapCat」—— 自动下载官方 NapCat.Shell → 解压 → 幂等写入 OneBot11 反向 WS 配置（3001）→ 注册 systemd 用户服务 `dsh-napcat.service` → 启动 → 二维码自动出现，扫码即登录
- 🔍 **二维码诊断分级**：`/qq-remote/status` 现在区分 `napcat_not_running` / `webui_not_found` / `stale_qrcode` / `waiting`，设置页与完整面板直接显示原因，不再无限"等待"
- ❌ **重新登录不再假装成功**：NapCat 服务缺失时返回真实错误（含修复指引），前端恢复按钮并显示原因
- ⚡ **轮询优化**：QR 获取 5s 结果缓存 + WebUI 失败 10s 退避（避免登录限流）
- 🧭 探测增强：`/proc/<pid>/cwd` 与 `NAPCAT_WORKDIR` 反推 NapCat 工作目录；`~/.config/napcat` 等路径补充
- 🧪 e2e 回归扩至 16 用例（含四类 qrReason 诊断场景）


### v0.3.1（2026-08-16）—— 对齐插件市场 STANDARD 规范

- ✅ **修正市场类型判定**：安装脚本移入 `scripts/` 子目录 —— 根目录不再有 `install.sh`，市场正确识别为 **cordis-plugin**（此前会被误判为「脚本型」，跳过构建/依赖/注册/更新/卸载全管线）
- 📦 **改为产物型**：提交 `lib/` 构建产物，市场安装无需构建弹窗、直接复制使用
- 📝 package.json 完善：`main` / `repository` / `files`（含 `scripts`）对齐规范；npm 包名唯一性已确认
- 🛠️ 安装命令更新：`bash scripts/install.sh`（卸载 `bash scripts/uninstall.sh`，诊断 `bash scripts/repair.sh`）


### v0.3.0（2026-08-16）—— 模块化重构 + 彻底卸载

- 🧱 **代码重构**：单文件（1700+ 行）拆分为模块化结构 —— `index.js`（装配）+ `util/onebot/chat/commands/panel/qrgen` 六模块，行为完全一致（本机全量回归：消息链路 9/9、面板路由、QR 生成器交叉验证）
- 🗑️ **彻底卸载**：`uninstall.sh` 增强 —— 移除 patch 条目 + 删除安装目录（含 junction）+ 清理注入器 registry + 清理 profile package.json 残留（dependencies/bundles）；`bash uninstall.sh --purge` 可连配置与聊天记忆一起删除
- 🧪 **回归测试入库**：`test/e2e.mjs` 一键跑消息链路 + QR 生成器验证（`cd test && node e2e.mjs`）
- 🩺 保留 v0.2.4 的 install.sh 自愈能力（写前备份、disabled 自动启用、安装后结构检查）

### v0.2.4（2026-08-16）—— 重装自愈 + 诊断工具

- 🔧 **重装自动启用**：若 patch 中残留 `disabled: true` 的旧条目（卸载残留），重新安装时自动移除 disabled 恢复启用
- 🔧 **写前备份**：install.sh 修改 `cordis.patch.yml` 前自动备份为 `cordis.patch.yml.bak-install`，任何意外可一键回滚
- 🩺 **新增 `repair.sh` 诊断工具**：列出 patch 全部插件条目、检测旧版 install.sh 造成的残缺结构（子行被删）、提示皮肤类条目是否缺失、发现备份文件时给出恢复命令；安装完成时自动运行检查
- 📦 repair.sh 随包分发（安装目录与 tgz 均包含）

### v0.2.3（2026-08-16）—— 修复皮肤插件失效 + 二维码自动获取

- 🐛 **修复安装后其他插件（如皮肤 UI）失效**：install.sh 不再对已有 patch 条目做任何清理/重排（旧逻辑会误删其他插件的嵌套配置），只做幂等追加
- ✨ **二维码自动获取**：面板不再依赖猜测 NapCat 安装路径 —— 自动读取 NapCat WebUI 配置（webui.json）调用 `GetQQLoginQrcode` API 主动获取二维码并本地生成 PNG（内置零依赖 QR 生成器）；Docker / 自定义目录 / 任意安装方式都能显示二维码
- 🧭 二维码候选路径扩展：NapCat.Shell、Installer、`.config/QQ/NapCat`、macOS 路径、systemd `NAPCAT_WORKDIR` 反推全覆盖
- 🔧 新增 `webuiPort` / `webuiToken` 配置项（默认自动探测，一般无需配置）

### v0.2.2（2026-08-16）—— 安装可靠性 + 面板路由 + 白名单

- 🐛 **修复面板路由不注册**：注册条目补 `inject: [webServer, tools]`（cordis.patch.yml / install.sh 模板）；插件代码增加 webServer 未就绪的延迟重试 + 防重复注册 —— 通过 `dsh plugin` 官方安装后 `/qq-remote/*` 路由必定注册
- ✨ **设置页新增白名单管理**：「QQ 远程」面板可增删控制白名单（QQ 号）并保存到 `~/.dsh/qq-remote.json`，即时生效

**安装/卸载**
- 🔧 YAML-aware patch 写入：正确处理空模板 `[]`、精确幂等匹配、原子替换（临时文件+rename）
- 🔧 client 路径统一：`exports["./client"]` 指向 `lib/client.js`（唯一路径），安装后强制校验存在
- 🔧 新增 `dsh.bundle.patch` 声明：支持 `dsh plugin` 官方安装流程（profile bundle 装配）
- 🔧 依赖版本从当前 DSH 运行时探测（不再猜 npx 缓存 / 硬编码漂移）
- 🔧 新增 `uninstall.sh`：移除 patch 条目 + 删除安装目录 + 清理注入器 registry（防重启复活）
- 🔧 平台表述修正：明确 Linux/macOS（Windows 需 WSL 或 Git Bash）
- 🐛 修复残留空 `- insert:` 块：重复安装后 patch 文件保持干净（幂等且不留垃圾行）

**体验**
- 🐛 面板容错：服务未就绪时显示友好提示并自动重试（不再报 JSON.parse 原始错误）
- 🐛 修复设置面板偶发整体消失：面板状态改为增量合并，白名单/输入框内容不再被覆盖丢失
- 🐛 登录失效时新增"等待二维码"提示文案；二维码候选路径扩展到更多常见 NapCat 安装位置
- 🎭 默认聊天人设改为中性"聊天格式"预设（不定义角色，角色可自由配置）

### v0.2.0（2026-08-15）

**新功能**
- 🖥️ **QQ 图形开关**：DSH 设置页新增「QQ 远程」面板（Web UI 设置 → QQ 远程）—— 实时显示插件/登录状态，一键重新登录，登录失效时**自动弹出二维码**（手机扫码即登）
- 🎛️ **控制面板页面**：`http://127.0.0.1:3080/qq-remote/panel`（完整面板，`/panel` 命令可获取链接）
- ⚡ **指令缩写**：长命令新增等效缩写（原命令不变）—— `/st` `/ss` `/s` `/ns` `/cb` `/pg` `/sc` `/q` `/x` `/run` `/task` `/h` `/pn`，`/help` 查看对照
- 💬 聊天模式增强：多聊天会话（`/chat <名字>`）、记忆持久化（`~/.dsh/qq-remote-chats/`）、上下文无限制
- 💗 聊天特化会话（`/chatbind`）：指定会话直接聊天回复，其他会话不受影响
- 📋 会话标题化：`/sessions` 显示标题，`/session <序号|标题|id>` 切换，`/title` 重命名，`/newsession` 新建
- 📦 一键安装脚本 `install.sh`

**Bug 修复**
- 🐛 聊天模式第二轮崩溃（`reading 'kind'`）：消息缺少 `source` 字段导致 LLM 管道报错
- 🐛 `/newsession` 创建的会话随插件重载消失：改为根上下文创建，生命周期独立
- 🐛 重启后 QQ 连接不自动恢复：看门狗增加 CONNECTING 卡死判定（15 秒未连接强制重建）
- 🐛 语音/图片消息无响应：改为友好提示"请用文字发送"
- 🐛 会话标题显示 `[object Object]`：正确读取标题对象
- 🐛 设置页空白（`locale.t is not a function`）：改用新版 locale API（`ctx.locale.bind`）

**平台**
- Linux 完整支持；macOS/Windows 核心功能可用（详见"环境要求"）

### v0.1.0（2026-08-15）

- 首个开源版本：OneBot 11 桥接、`/exec`、`/ask`、阶段进度汇报、截图回传、`qq_report`/`qq_screenshot` 工具、零 npm 依赖
