# dsh-qq-remote — 通过 QQ 远程控制 DeepSeek Harness

零 npm 依赖的 DSH 插件（Node ≥22 内置 WebSocket + fetch）。桥接 **OneBot 11** 协议，
兼容 NapCat / Lagrange.OneBot / go-cqhttp / LLOneBot。

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

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22（使用内置 WebSocket / fetch，零 npm 依赖） |
| 宿主 | DeepSeek Harness（DSH）环境，提供 `@deepseek-ai/*` peer 依赖 |
| QQ 桥 | 任一 OneBot 11 实现（NapCat / Lagrange.OneBot / go-cqhttp / LLOneBot） |
| 平台 | Linux 完整支持；macOS / Windows 核心功能可用（见下） |

**平台支持情况：**
- ✅ **全平台通用**：QQ 消息桥接、任务派发、阶段汇报、AI 聊天、会话管理、Agent 工具
- ⚠️ **Linux 最佳**：`/exec` 使用 bash；截图自动走 xdg-desktop-portal / grim / scrot 等
- ⚠️ **macOS / Windows**：`/exec` 需环境提供 bash（如 WSL / Git Bash）；截图需在 `screenshotCommand` 配置本平台工具（如 macOS `screencapture -x <path>`），否则 `/screenshot` 不可用

## 安装与配置

### 一键安装（推荐，开源用户）

```bash
git clone https://github.com/ASAKAFENG/dsh-qq-remote
cd dsh-qq-remote
bash install.sh
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

## 命令一览

```
/help         查看全部命令（含缩写对照）        /h
/ping         连通性测试                        /pong
/status       查看 agent 状态                   /st
/sessions     列出会话（标题+ID+状态）          /ss
/session <序号|标题|id>  切换目标会话           /s
/title <名称> 给当前目标会话重命名              /rename
/newsession <id> 新建会话并切换                 /ns
/ask <任务>   派发任务（私聊直接发消息也行）     /task
/cancel       取消当前任务                      /x
/exec <命令>  在电脑上执行 shell 命令           /run
/progress [n] 查看最近进度                      /pg
/screenshot   截图并发送给你                    /sc
/quiet on|off 开关进度自动推送                  /q
/chat on|off  纯净聊天模式                      （/chat <名字> 切换会话）
/chatbind on|off 聊天特化会话（直接聊天）       /cb
/panel        打开 QQ 控制面板                  /pn
```

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
