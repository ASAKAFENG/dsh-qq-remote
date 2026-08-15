# dsh-qq-remote 使用文档

通过 QQ 消息远程控制 DeepSeek Harness（DSH）：执行命令、派发任务、查看进度、截屏回传、AI 聊天。

- 插件位置：仓库根目录（构建后 `lib/` 为运行产物）
- 插件名：`@dsh-external/dsh-qq-remote`（已注入 DSH web profile，重启自动恢复）
- 协议：OneBot 11（兼容 NapCat / Lagrange.OneBot / go-cqhttp / LLOneBot）
- 依赖：零 npm 依赖（Node ≥22 内置 WebSocket/fetch）

---

## 〇、环境要求与平台支持

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 22（内置 WebSocket / fetch，零 npm 依赖） |
| 宿主 | DeepSeek Harness（DSH），提供 `@deepseek-ai/*` peer 依赖 |
| QQ 桥 | 任一 OneBot 11 实现（NapCat / Lagrange.OneBot / go-cqhttp / LLOneBot） |
| 平台 | Linux 完整支持；macOS / Windows 核心功能可用 |

- ✅ **全平台通用**：QQ 消息桥接、任务派发、阶段汇报、AI 聊天、会话管理、Agent 工具
- ⚠️ **Linux 最佳**：`/exec` 使用 bash；截图自动走 xdg-desktop-portal / grim / scrot 等
- ⚠️ **macOS / Windows**：`/exec` 需环境提供 bash（如 WSL / Git Bash）；截图需在 `screenshotCommand` 配置本平台工具（如 macOS `screencapture -x <path>`）

---

## 一、整体架构

```
你的 QQ ──消息──▶ NapCat（OneBot 11，跑在这台电脑上）
                    │ 反向 WebSocket ws://127.0.0.1:3001/ws
                    ▼
              dsh-qq-remote 插件（运行在 DSH 进程内）
                    │
        ┌───────────┼───────────────┬──────────────┐
        ▼           ▼               ▼              ▼
   shell 命令    DSH agent 会话   屏幕截图      AI 聊天
   (/exec)      (/ask 派发任务)  (/screenshot)  (/chat)
                    │
             进度事件监听 → 阶段总结 → 回传你的 QQ
```

**推荐部署**：
- NapCat 通过 systemd 用户服务自启动（示例：`~/.config/systemd/user/napcat-qq.service`），开机自动运行 + `-q <机器人QQ号>` 快速登录（免扫码）
- 机器人号：`<机器人QQ号>`；控制端：`<你的QQ号>`（配置到 `allowedUsers`）
- 聊天记忆持久化在 `~/.dsh/qq-remote-chats/<会话名>.json`（本地数据，注意备份）

---

## 二、快速开始（3 步）

### 第 1 步：运行 NapCat（QQ 机器人框架）

1. 下载安装 NapCat（Linux）：
   ```bash
   curl -o napcat.sh https://nclatest.znin.net/NapNeko/NapCatQQ/raw/main/install.sh
   sudo bash napcat.sh
   ```
2. 启动并登录（扫码登录，建议用**小号/机器人号**）：
   ```bash
   napcat
   ```
3. 打开 WebUI（默认 `http://127.0.0.1:6099/webui`）→ **网络配置**，开启：
   - **WebSocket 服务器**（即 OneBot 反向 WS）：端口 `3001`，路径 `/ws`
   - （可选）HTTP 服务器端口 `3000`，插件可走 HTTP 发送
   - 如设置 Access Token，需同步填到插件配置 `token`

> 不同 NapCat 版本菜单位置略有差异，核心就是「开启 WS 服务端，端口 3001，路径 /ws」。
> 本机已配置 systemd 自启动 + 快速登录，无需每次手动操作。

### 第 2 步：配置白名单（强烈建议）

编辑 `~/.dsh/qq-remote.json`：

```json
{
  "wsUrl": "ws://127.0.0.1:3001/ws",
  "allowedUsers": [123456789],
  "groupPrefix": "/",
  "privatePlainAsTask": true,
  "autoReport": true
}
```

- `allowedUsers`：**控制端 QQ 号**（给你发命令的号）。空白名单 = 任何人给机器人发消息都能控制电脑（危险！）
- 改完配置后 DSH 侧执行 `dev_reload_package` 或重启 DSH

### 第 3 步：开始使用

私聊机器人即可：**直接发消息 = 派任务**，或使用 `/` 命令（见下）。

---

## 三、QQ 命令手册

### 私聊（机器人）

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| 直接发消息 | 作为任务派发给 DSH agent（聊天特化会话则直接聊天） | `帮我看一下 /path/to/project 里的文件` |
| `/ask <任务>` | 显式派发任务 | `/ask 检查磁盘空间并汇报` |
| `/exec <命令>` | 在电脑上执行 shell 命令 | `/exec df -h` |
| `/status` | 查看当前 agent 状态（轮次/步数/正在做什么） | `/status` |
| `/progress [n]` | 回放最近 n 条进度（默认 10） | `/progress 20` |
| `/sessions` | 列出所有会话（标题+ID+状态+序号） | `/sessions` |
| `/session <序号\|标题\|id>` | 切换目标会话（序号/标题模糊/ID 精确） | `/session 2`、`/session ai女友` |
| `/title <名称>` | 给当前目标会话重命名（改完可用标题切换） | `/title 我的测试` |
| `/newsession <id>` | 新建 agent 会话并切换（自动以 id 为标题） | `/newsession ai女友` |
| `/chatbind on\|off` | 把当前目标会话绑定/解绑为**聊天特化**（发消息=直接聊天） | `/chatbind on` |
| `/chat on\|off` | 全局纯净聊天模式开关 | `/chat on` |
| `/chat <名字>` | 切换到指定聊天会话（独立记忆） | `/chat ai女友` |
| `/chat list` | 列出所有聊天会话 | `/chat list` |
| `/chat clear` | 清空当前聊天会话的记忆 | `/chat clear` |
| `/cancel` | 取消当前任务 | `/cancel` |
| `/screenshot` | 截屏并作为图片发给你 | `/screenshot` |
| `/quiet on\|off` | 开关进度自动推送 | `/quiet off` |
| `/ping` | 连通性测试 | `/ping` |
| `/help` | 查看命令列表 | `/help` |

### 群聊

- 所有命令需加前缀（默认 `/`）：`/status`、`/screenshot`…
- 只有 `allowedUsers` 里的 QQ 号在群里发命令才生效

---

## 四、会话管理（标题 / 序号 / 新建）

DSH 会为每个会话**自动生成默认标题**（LLM 从首条消息提炼），插件完整支持标题化操作：

```
/sessions        →  列表：序号. 「标题」 id [状态] 第N轮 🎯（🎯=当前目标）
/session 2       →  按序号切换
/session ai女友  →  按标题模糊匹配切换（唯一匹配直接切，多匹配列候选）
/session <id>    →  按 ID 精确切换
/title 新名字    →  给当前目标会话重命名（改完立即可用新标题切换）
/newsession xxx  →  新建会话并切换（自动用 xxx 作标题；生命周期挂在 DSH 根进程，
                     插件更新/重载不会销毁它）
```

> ⚠️ DSH 整个进程重启后，动态新建的会话不会自动恢复（只有配置里声明的会话会 resume）。需要长期保留的会话可加入 `cordis.patch.yml` 的 agent 配置。

---

## 五、AI 聊天（纯净聊天模式 & 聊天特化会话）

插件提供两种"像人一样聊天"的形态：

### 1. 全局聊天模式 `/chat on`

- 开启后，**所有私聊非命令消息**直接走 LLM 聊天（不走任务、不调工具、不推进度）
- 直连 DSH 默认模型，回复自然口语化（人设见 `chatSystemPrompt` 配置）
- `/chat off` 退出；`/chat <名字>` 切换聊天会话（每个会话一份独立记忆）

### 2. 聊天特化会话 `/chatbind`（推荐 · AI 女友形态）

把**某个 DSH 会话**绑定为聊天特化：切到该会话后，发消息 = 直接聊天回复（真实 QQ 对话感），其他会话完全不受影响。

```
/newsession ai女友   新建会话
/chatbind on         绑定为聊天特化（持久化，重启保留）
直接开聊             发消息即聊天，不走任务
/chatbind off        解除绑定，恢复任务模式
```

### 聊天记忆

- **持久化**：每个聊天会话一份文件 `~/.dsh/qq-remote-chats/<会话名>.json`，回复后自动保存，重启 DSH 不丢
- **上下文无限制**：默认全量发送（`chatHistoryLimit` / `chatMaxChars` 为 0 = 不限）
- `/chat clear` 清空当前记忆；`/chat list` 查看所有聊天会话
- 聊天特化会话的记忆按**会话标题**存储，天然按会话隔离

---

## 六、进度汇报机制

**默认（`reportMode: phase`）阶段性总结** —— 不逐条刷屏，只在关键阶段汇报：

| 时机 | 你收到的内容 |
| --- | --- |
| 任务派发 | `✅ 任务已派发 / 会话 / 任务摘要` |
| 轮次结束 | `📊 第 N 轮小结（用时）+ 工具调用次数 + 最新进展 + 状态` |
| 任务完成 | `✅ 任务完成 + 结果摘要 + 用时 + 工具次数` |
| 任务出错 | `❌ 任务出错 + 原因` |
| 工具出错 | `⚠️ 工具出错`（即时） |
| 长任务心跳 | `⏳ 任务进行中（已 X 分钟）+ 当前轮/步 + 最近工具`（默认每 5 分钟） |

**`reportMode: live` 实时流水模式**（老行为）：turn/step/工具调用逐条推送，节流 3 秒。

- `/quiet off` 关闭自动推送，`/status`、`/progress` 随时手动查

---

## 七、agent 内置工具（agent 主动汇报）

DSH agent 在会话中还可以主动调用这两个工具：

| 工具 | 作用 |
| --- | --- |
| `qq_report(text)` | 主动向你的 QQ 发送文本（进度/结果/问题） |
| `qq_screenshot(caption?)` | 截屏并作为图片发到你的 QQ |

> 只有你通过 QQ 发过命令（建立"控制端"绑定）后，这两个工具才有发送对象。

---

## 八、配置项总表（`~/.dsh/qq-remote.json`）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `wsUrl` | `ws://127.0.0.1:3001/ws` | OneBot 反向 WS 地址 |
| `httpUrl` | `""` | 可选 HTTP API（如 `http://127.0.0.1:3000`），留空走 WS |
| `token` | `""` | OneBot Access Token（WS 走 `?access_token=`，HTTP 走 Bearer） |
| `allowedUsers` | `[]` | ⚠️ 控制端 QQ 号白名单；空 = 任何人可控制 |
| `groupPrefix` | `/` | 群消息命令前缀 |
| `privatePlainAsTask` | `true` | 私聊普通文本直接作为任务 |
| `autoReport` | `true` | 自动推送进度摘要 |
| `reportMode` | `phase` | 汇报模式：`phase`=阶段性总结（默认，不刷屏）／`live`=实时流水 |
| `phaseIntervalMs` | `300000` | phase 模式长任务心跳汇报间隔（毫秒） |
| `reportThrottleMs` | `3000` | 推送最小间隔（毫秒，live 模式） |
| `execAllowed` | `true` | 允许 `/exec` |
| `execTimeoutMs` | `120000` | `/exec` 超时（毫秒） |
| `execCwd` | `""` | `/exec` 工作目录（空 = agent 会话 cwd） |
| `targetSessionId` | `""` | 目标会话（空 = 最近活跃 agent 会话；`/session` 可改） |
| `screenshotCommand` | `""` | 自定义截图命令（如 `"grim /tmp/x.png"`） |
| `reconnectDelayMs` | `5000` | 断线重连间隔 |
| `maxMessageLen` | `3500` | 单条消息长度上限 |
| `chatSystemPrompt` | 通用友好人设 | 聊天模式人设提示词（现在配置的是 AI 女友人设） |
| `chatHistoryLimit` | `0` | 聊天历史条数上限（0 = 无限制全量） |
| `chatMaxChars` | `0` | 聊天历史字符预算（0 = 无限制） |
| `chatSessionNames` | `[]` | 聊天特化会话名单（标题或 id；`/chatbind` 自动维护） |

---

## 九、截图原理

1. 优先调用 **xdg-desktop-portal Screenshot**（GNOME Wayland 免安装、免交互）
2. 失败则依次尝试：`screenshotCommand` 自定义命令 → `grim` → `scrot` → `maim` → `import` → `gnome-screenshot`
3. 截图为 PNG，以 base64 图片消息发送（约 1~3MB）

---

## 十、无 QQ 环境测试（模拟端）

仓库自带 OneBot 模拟服务端，无需 QQ 即可体验全部功能：

```bash
cd test
npm i            # 安装 ws（仅测试依赖）
node onebot-mock.mjs 3001
```

然后在该进程 stdin 输入（另一个终端执行 `echo 'msg ...' > /tmp/obmock.in` 亦可，mock 从该 FIFO 读指令）：

```
msg 123456 /exec echo hello      # 模拟私聊
msg 123456 /screenshot           # 截图（保存到 test/out/）
gmsg 10001 123456 /ping          # 模拟群聊
quit                             # 退出
```

---

## 十一、常见问题（FAQ）

**Q: 发消息没反应？**
- 检查 NapCat 是否运行、WS 端口/路径是否与 `wsUrl` 一致
- 检查你的 QQ 号是否在 `allowedUsers` 白名单里
- 群聊记得加前缀 `/`

**Q: 怎么改配置？**
- 编辑 `~/.dsh/qq-remote.json` → DSH 侧执行 `dev_reload_package`（参数 `dsh-qq-remote`）或重启 DSH

**Q: 聊天报"对话出错"？**
- 上下文太长超模型窗口时会有提示 → `/chat clear` 清空记忆，或在配置里设 `chatHistoryLimit` / `chatMaxChars`
- 检查默认模型是否配置（`/status` 可看）

**Q: /newsession 创建的会话重启后没了？**
- 插件更新/热重载不会丢（已修复）；但 DSH 整个进程重启后动态会话不自动恢复，需要长期保留的会话加入 `cordis.patch.yml` 配置

**Q: 截图失败？**
- 看错误信息；可在 `screenshotCommand` 配置你机器上可用的截图命令（如 KDE 用 `spectacle -b -n -o /tmp/x.png`）

**Q: 会不会误伤主号？**
- 建议 NapCat 登录**小号**，避免主号被风控；`/exec` 权限可用 `execAllowed: false` 整体关闭

**Q: 任务派发后 agent 没反应？**
- `/status` 查看 agent 状态；任务会排队到当前轮结束后的下一轮执行（FIFO）
- `/cancel` 可取消排队/执行中的任务

---

## 十二、安全提示

1. `allowedUsers` 务必配置，否则任何人可控电脑
2. `/exec` 可执行任意命令——仅对白名单用户开放，必要时 `execAllowed: false`
3. 建议使用小号 + 独立的 NapCat 实例
4. 电脑上正在进行的 DSH 会话进度会自动回传 QQ——属于预期行为，可用 `/quiet off` 关闭
