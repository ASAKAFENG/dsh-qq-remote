/**
 * dsh-qq-remote — 通过 QQ 消息远程控制 DeepSeek Harness。
 *
 * 桥接 OneBot 11 协议（NapCat / Lagrange.OneBot / go-cqhttp / LLOneBot），
 * 零 npm 依赖（使用 Node ≥22 内置 WebSocket）。
 *
 * 能力：
 *  - 命令执行   /exec <shell>          在宿主执行 shell 命令并回传输出
 *  - 任务派发   /ask <任务> / 私聊直发  注入当前 agent 会话，agent 开始执行
 *  - 进度查看   /status /progress /sessions /session
 *  - 远程控制   /cancel /quiet /ping
 *  - 截图回传   /screenshot             截取屏幕并作为图片消息发送
 *  - Agent 工具 qq_report / qq_screenshot：agent 在会话中主动向 QQ 汇报/发截图
 *  - 进度推送   turn/step/tool/assistant 事件 → 节流摘要回传 QQ
 *
 * 安全：allowedUsers 白名单（QQ 号）；群消息仅响应命令前缀；/exec 可关。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

/** Cordis 插件名。 */
export const name = "qq-remote";
/** 声明注入的服务（tools 必用；agents/sessions 走 ctx.get 可选访问）。 */
export const inject = ["tools"];

/** 插件配置。 */
export const Config = z.object({
  /** OneBot 11 反向 WebSocket 地址（事件 + API 同一条连接）。 */
  wsUrl: z.string().default("ws://127.0.0.1:3001/ws"),
  /** 可选 HTTP API 地址（如 http://127.0.0.1:3000）；留空则仅走 WS。 */
  httpUrl: z.string().default(""),
  /** OneBot 访问令牌（WS 走 ?access_token= 查询参数，HTTP 走 Authorization: Bearer）。 */
  token: z.string().default("").role("secret"),
  /** 允许控制的 QQ 号白名单；空数组 = 允许所有人（不安全，建议配置）。 */
  allowedUsers: z.array(z.number()).default([]),
  /** 群消息命令前缀。 */
  groupPrefix: z.string().default("/"),
  /** 私聊非命令消息是否直接作为 agent 任务派发。 */
  privatePlainAsTask: z.boolean().default(true),
  /** 自动向控制端推送进度摘要。 */
  autoReport: z.boolean().default(true),
  /** 汇报模式：phase=阶段性总结汇报（不刷屏，默认）；live=实时流水。 */
  reportMode: z.union([z.const("phase"), z.const("live")]).default("phase"),
  /** phase 模式下长任务的心跳汇报间隔（毫秒）。 */
  phaseIntervalMs: z.number().default(300000),
  /** 进度推送最小间隔（毫秒），防刷屏（live 模式用）。 */
  reportThrottleMs: z.number().default(3000),
  /** 是否允许 /exec 执行任意 shell 命令。 */
  execAllowed: z.boolean().default(true),
  /** /exec 超时（毫秒）。 */
  execTimeoutMs: z.number().default(120000),
  /** /exec 工作目录；留空 = agent 会话 cwd 或 DSH 进程 cwd。 */
  execCwd: z.string().default(""),
  /** 目标会话 id（agent 的 sessionId）；留空 = 最近活跃的 agent 会话。 */
  targetSessionId: z.string().default(""),
  /** 自定义截图命令（如 "grim /tmp/x.png"）；留空 = 自动探测。 */
  screenshotCommand: z.string().default(""),
  /** 断线重连间隔（毫秒）。 */
  reconnectDelayMs: z.number().default(5000),
  /** 单条 QQ 消息最大长度（字符），超出截断。 */
  maxMessageLen: z.number().default(3500),
  /** 纯净聊天模式的人设提示词。 */
  chatSystemPrompt: z.string().default("你是一个友好的 AI 伙伴，像真人一样自然地用中文聊天，回复简洁、自然、有温度，不要提你是模型或助手。"),
  /** 聊天模式保留的历史消息条数上限（0 = 无限制，全量发送）。 */
  chatHistoryLimit: z.number().default(0),
  /** 聊天历史总字符预算（0 = 无限制）。 */
  chatMaxChars: z.number().default(0),
  /** 聊天特化会话名单（标题或 id）：这些会话的私聊消息直接进入聊天回复，不走任务。 */
  chatSessionNames: z.array(z.string()).default([]),
  /** NapCat 登录二维码文件路径（留空自动探测常见安装位置）。 */
  qrcodePath: z.string().default(""),
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 截断文本到上限，附截断标记。 */
function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[已截断，共 ${s.length} 字符]`;
}

/** 提取 OneBot 消息里的纯文本（segment 数组或 CQ 字符串）。 */
function extractText(message) {
  if (typeof message === "string") return message.replace(/\[CQ:[^\]]*\]/g, "").trim();
  if (!Array.isArray(message)) return "";
  return message
    .filter((seg) => seg && seg.type === "text" && typeof seg.data?.text === "string")
    .map((seg) => seg.data.text)
    .join("")
    .trim();
}

/** 提取消息里的非文本媒体类型（record/image/file/video…）。 */
function extractMediaTypes(message) {
  if (!Array.isArray(message)) return [];
  return [...new Set(
    message.map((seg) => seg?.type).filter((t) => t && !["text", "at", "face"].includes(t))
  )];
}

/** 事件类型 → 进度行（无映射返回 null）。 */
function formatEventLine(event) {
  switch (event.type) {
    case "turn/start":
      return `▶️ 第 ${event.data.turn} 轮开始`;
    case "step/start":
      return `· 第 ${event.data.turn} 轮 / 第 ${event.data.step} 步`;
    case "tool/call": {
      let args = "";
      try {
        args = truncate(JSON.stringify(event.data.arguments ?? {}), 120);
      } catch {
        args = "?";
      }
      return `🔧 工具: ${event.data.name}(${args})`;
    }
    case "tool/result": {
      const block = event.data.message?.content?.[0];
      if (block?.isError || event.data.error) {
        return `⚠️ 工具出错: ${truncate(block?.content?.[0]?.text ?? event.data.error?.message ?? "未知错误", 200)}`;
      }
      return null; // 成功结果不单独推送（避免刷屏）
    }
    case "assistant/message": {
      const text = extractAssistantText(event.data.message);
      if (!text) return null;
      return `🤖 DSH: ${truncate(text, 300)}`;
    }
    case "turn/end": {
      const reason = event.data.reason;
      const kind = reason?.kind ?? "?";
      if (kind === "error") return `❌ 第 ${event.data.turn} 轮出错: ${truncate(reason?.error?.message ?? "未知", 200)}`;
      if (kind === "aborted") return `⏹️ 第 ${event.data.turn} 轮被中止`;
      return `🏁 第 ${event.data.turn} 轮结束 [${kind}]`;
    }
    default:
      return null;
  }
}

/** 从 assistant message 提取文本块。 */
function extractAssistantText(message) {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * 截屏：优先 xdg-desktop-portal Screenshot（GNOME Wayland 无需额外工具），
 * 其次自定义命令 / grim / scrot / gnome-screenshot / import。
 * @returns {Promise<{file: string, base64: string}>}
 */
async function takeScreenshot(config) {
  const out = path.join(os.tmpdir(), `qq-remote-${Date.now()}.png`);
  const candidates = [];

  if (config.screenshotCommand) {
    candidates.push({ kind: "shell", cmd: config.screenshotCommand, out });
  }
  candidates.push({ kind: "portal", out });
  for (const bin of ["grim", "scrot", "maim", "import"]) {
    if (binAvailable(bin)) candidates.push({ kind: "bin", bin, out });
  }
  if (binAvailable("gnome-screenshot")) {
    candidates.push({ kind: "bin", bin: "gnome-screenshot", args: ["-f", out], out });
  }

  for (const cand of candidates) {
    try {
      if (cand.kind === "shell") {
        const res = await runProcess("/bin/bash", ["-c", cand.cmd], { timeout: 20000 });
        if (res.code !== 0) throw new Error(`退出码 ${res.code}`);
      } else if (cand.kind === "bin") {
        const args = cand.args ?? [out];
        const res = await runProcess(cand.bin, args, { timeout: 20000 });
        if (res.code !== 0) throw new Error(`退出码 ${res.code}`);
      } else {
        const uri = await portalScreenshot(20000);
        if (!uri) throw new Error("portal 无响应");
        return await readImage(uri);
      }
      if (fs.existsSync(out) && fs.statSync(out).size > 0) {
        return { file: out, base64: fs.readFileSync(out).toString("base64") };
      }
    } catch {
      // 尝试下一个
    }
  }
  throw new Error("没有可用的截图方式（可配置 screenshotCommand）");
}

/** 检查可执行文件是否存在。 */
function binAvailable(bin) {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  return paths.some((p) => {
    try {
      fs.accessSync(path.join(p, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** 通过 xdg-desktop-portal 非交互截屏（GNOME Wayland），返回 file:// URI。 */
function portalScreenshot(timeoutMs) {
  return new Promise((resolve) => {
    const monitor = spawn("busctl", ["--user", "monitor"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    let settled = false;
    const finish = (uri) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        monitor.kill("SIGKILL");
      } catch {}
      resolve(uri);
    };
    monitor.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/file:\/\/([^"\s]+)/);
      if (m) {
        try {
          finish(decodeURIComponent(m[1]));
        } catch {
          finish(m[1]);
        }
      }
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    // 先起监控再调用，避免竞态丢信号（调用用 gdbus：busctl 的 a{sv} 参数解析有坑）
    setTimeout(() => {
      const call = spawn("gdbus", [
        "call", "--session",
        "--dest", "org.freedesktop.portal.Desktop",
        "--object-path", "/org/freedesktop/portal/desktop",
        "--method", "org.freedesktop.portal.Screenshot.Screenshot",
        "",
        "{'interactive': <false>, 'modal': <false>}",
      ], { stdio: "ignore" });
      call.on("error", () => finish(null));
    }, 300);
  });
}

/** 读取截图文件为 base64。 */
async function readImage(uri) {
  let file = uri;
  if (file.startsWith("file://")) file = file.slice("file://".length);
  const b64 = fs.readFileSync(file).toString("base64");
  return { file, base64: b64 };
}

/** 执行进程，捕获输出。 */
function runProcess(bin, args, { timeout = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let killed = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, signal: null, out: "", err: String(e), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeout);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, out, err: String(e), timedOut: killed });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, timedOut: killed });
    });
  });
}

/** 从 ~/.dsh/qq-remote.json 读取配置覆盖层（可选；便于注入后免改代码调整参数）。 */
function loadConfigOverlay() {
  try {
    const p = path.join(os.homedir(), ".dsh", "qq-remote.json");
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (e) {
    console.warn(`[qq-remote] 读取 ~/.dsh/qq-remote.json 失败: ${e.message}`);
  }
  return {};
}

export function apply(ctx, config) {
  const log = ctx.logger ?? console;
  // 配置覆盖层：loader 传入的 schema 解析结果 + ~/.dsh/qq-remote.json
  config = { ...config, ...loadConfigOverlay() };

  // ── 运行时状态 ────────────────────────────────────────────────
  /** 当前 QQ 控制端（最近一条命令的发送者）。 */
  let controller = null; // { userId, groupId, isPrivate }
  /** OneBot 连接状态。 */
  let ws = null;
  let wsSeq = 0;
  let reconnectTimer = null;
  const waiters = new Map(); // echo -> {resolve, reject, timer}
  let lastReportAt = 0;
  let pendingReports = [];
  let pendingTimer = null;
  /** 每个会话最近事件时间戳（用于挑选最近活跃 agent）。 */
  const lastEventAt = new Map();
  /** 正在跟踪的任务。 */
  let activeTask = null; // { sessionId, startTurn, startedAt }
  /** 纯净聊天模式开关（/chat on|off）。 */
  let chatMode = false;
  /** 当前聊天会话名（每个会话一份持久化记忆）。 */
  let chatName = "default";
  /** 聊天记忆：会话名 -> 消息数组（磁盘 ~/.dsh/qq-remote-chats/<name>.json）。 */
  const chats = new Map();
  /** 插件是否已停止。 */
  let disposed = false;
  /** 看门狗：周期性检查连接，未连接则重连（不依赖 close 事件）。 */
  let watchdogTimer = null;
  /** 最近一次 WebSocket 创建时间（用于判定 CONNECTING 卡死）。 */
  let wsCreatedAt = 0;

  // ── OneBot 连接 ────────────────────────────────────────────────
  function connect() {
    if (disposed || !config.wsUrl) return;
    try {
      let url = config.wsUrl;
      if (config.token && !url.includes("access_token")) {
        url += (url.includes("?") ? "&" : "?") + `access_token=${encodeURIComponent(config.token)}`;
      }
      log.info(`[qq-remote] 连接 OneBot: ${url}`);
      ws = new WebSocket(url);
      ws.onopen = () => {
        log.info("[qq-remote] OneBot 已连接");
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg && typeof msg === "object") {
          if (msg.echo && waiters.has(String(msg.echo))) {
            const w = waiters.get(String(msg.echo));
            waiters.delete(String(msg.echo));
            clearTimeout(w.timer);
            if (msg.status === "ok" && (msg.retcode === 0 || msg.retcode === undefined)) w.resolve(msg.data);
            else w.reject(new Error(msg.status === "failed" ? `retcode=${msg.retcode}` : `status=${msg.status}`));
            return;
          }
          if (msg.post_type === "message") handleMessageEvent(msg);
        }
      };
      ws.onclose = () => {
        log.warn("[qq-remote] OneBot 连接断开，重连中…");
        ws = null;
        for (const w of waiters.values()) {
          clearTimeout(w.timer);
          w.reject(new Error("连接已断开"));
        }
        waiters.clear();
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    } catch (e) {
      log.warn(`[qq-remote] 连接失败: ${e.message}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer || !config.wsUrl) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, config.reconnectDelayMs);
  }

  /** 看门狗：连接不在 OPEN 状态就发起重连（每 10s 检查一次）。 */
  function startWatchdog() {
    if (disposed || watchdogTimer || !config.wsUrl) return;
    watchdogTimer = setInterval(() => {
      if (disposed) return;
      const state = ws?.readyState;
      const connecting = state === WebSocket.CONNECTING;
      const alive = state === WebSocket.OPEN;
      if (!alive && !connecting && !reconnectTimer) scheduleReconnect();
    }, 10000);
  }

  /** OneBot API 调用：优先 WS action（echo 关联），其次 HTTP。 */
  function api(action, params, timeout = 15000) {
    if (config.httpUrl) {
      const headers = { "Content-Type": "application/json" };
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      return fetch(config.httpUrl.replace(/\/$/, "") + "/" + action, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      })
        .then((r) => r.json())
        .then((j) => {
          if (j.status === "ok" && (j.retcode === 0 || j.retcode === undefined)) return j.data;
          throw new Error(`OneBot API 失败: ${action} → ${j.status}/${j.retcode} ${j.message ?? ""}`);
        });
    }
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("OneBot 未连接"));
        return;
      }
      const echo = `qqr_${++wsSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        waiters.delete(echo);
        reject(new Error(`OneBot API 超时: ${action}`));
      }, timeout);
      waiters.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        waiters.delete(echo);
        reject(e);
      }
    });
  }

  /** 发送文本消息。 */
  async function sendText(userId, groupId, text) {
    const message = [{ type: "text", data: { text: truncate(text, config.maxMessageLen) } }];
    if (groupId) return api("send_group_msg", { group_id: groupId, message });
    return api("send_private_msg", { user_id: userId, message });
  }

  /** 发送图片消息（base64）。 */
  async function sendImage(userId, groupId, base64, caption) {
    const message = [{ type: "image", data: { file: `base64://${base64}` } }];
    if (caption) message.unshift({ type: "text", data: { text: truncate(caption, 200) } });
    if (groupId) return api("send_group_msg", { group_id: groupId, message });
    return api("send_private_msg", { user_id: userId, message });
  }

  /** 向当前控制端发送。 */
  async function reply(text) {
    if (!controller) throw new Error("没有绑定的 QQ 控制端");
    await sendText(controller.userId, controller.groupId, text);
  }

  // ── 消息处理 ──────────────────────────────────────────────────
  function authorized(userId) {
    if (!config.allowedUsers || config.allowedUsers.length === 0) {
      log.warn(`[qq-remote] 警告: allowedUsers 未配置白名单，QQ ${userId} 的消息将被接受`);
      return true;
    }
    return config.allowedUsers.includes(userId);
  }

  async function handleMessageEvent(ev) {
    if (ev.message_type !== "private" && ev.message_type !== "group") return;
    const userId = ev.user_id;
    if (!authorized(userId)) return;
    const groupId = ev.group_id;
    let text = extractText(ev.message);
    if (!text) {
      // 纯媒体消息（语音/图片/文件…）：不静默，给友好提示
      const media = extractMediaTypes(ev.message);
      if (media.length > 0 && ev.message_type === "private") {
        controller = { userId, groupId, isPrivate: true };
        const hint = media.includes("record")
          ? "🎤 收到语音啦～我暂时听不懂语音，请用文字发给我哦"
          : `📎 收到 ${media.join("/")} 消息，暂不支持处理，请用文字发送～`;
        try {
          await reply(hint);
        } catch {}
      }
      return;
    }
    const isPrivate = ev.message_type === "private";
    if (!isPrivate) {
      if (!text.startsWith(config.groupPrefix)) return;
      text = text.slice(config.groupPrefix.length).trim();
    }
    if (!text) return;
    controller = { userId, groupId, isPrivate };
    try {
      await routeCommand(text, isPrivate);
    } catch (e) {
      log.warn(`[qq-remote] 命令处理失败: ${e.message}`);
      try {
        await reply(`⚠️ 处理出错: ${truncate(e.message, 500)}`);
      } catch {}
    }
  }

  /** 解析并执行命令。私聊普通文本 = 任务。 */
  async function routeCommand(text, isPrivate) {
    const [head, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    const raw = head.toLowerCase();
    const cmd = raw.replace(/^\/+/, "");
    // 私聊必须以 / 开头才是命令；群消息已剥离前缀，一律按命令处理
    const isCommand = isPrivate ? raw.startsWith("/") : true;

    if (!isCommand) {
      if (isPrivate) {
        // 聊天特化会话：直接聊天回复（像真人 QQ）
        if (isChatTarget()) return chatReply(text);
        if (chatMode) return chatReply(text);
        if (config.privatePlainAsTask) return doAsk(text);
      }
      await reply("❓ 未识别的消息。发送 /help 查看命令。");
      return;
    }
    // 纯净聊天模式：仅允许聊天相关与基础命令
    if (chatMode && !["chat", "help", "h", "ping", "status", "st"].includes(cmd)) {
      await reply("💬 纯净聊天模式中，只聊天哦（可用 /chat /help /ping /status，/chat off 退出模式）");
      return;
    }
    switch (cmd) {
      case "chat":
        await doChatMode(arg);
        break;
      case "chatbind":
      case "cb":
        await doChatBind(arg);
        break;
      case "panel":
      case "pn":
        await reply(`🖥️ QQ 控制面板：http://127.0.0.1:3080/qq-remote/panel\n（浏览器打开，登录失效时可一键重登并显示二维码）`);
        break;
      case "help":
      case "h":
        await reply(helpText());
        break;
      case "ping":
      case "pong":
        await reply("🏓 pong（OneBot 连接正常）");
        break;
      case "status":
      case "st":
        await reply(statusText());
        break;
      case "sessions":
      case "ss":
        await reply(sessionsText());
        break;
      case "session":
      case "s":
        if (!arg) {
          await reply(sessionUsage());
          return;
        }
        await doSwitchSession(arg);
        break;
      case "title":
      case "rename":
        if (!arg) {
          await reply("用法: /title <名称>（给当前目标会话重命名，之后可用标题切换）");
          return;
        }
        await doTitle(arg);
        break;
      case "newsession":
      case "new-session":
      case "ns":
        if (!arg) {
          await reply("用法: /newsession <sessionId>（在当前工作区新建 agent 会话并切换）");
          return;
        }
        await doNewSession(arg);
        break;
      case "ask":
      case "task":
        if (!arg) {
          await reply("用法: /ask <任务描述>");
          return;
        }
        await doAsk(arg);
        break;
      case "cancel":
      case "x":
        await doCancel();
        break;
      case "exec":
      case "run":
        if (!config.execAllowed) {
          await reply("⛔ /exec 已被配置禁用（execAllowed=false）");
          return;
        }
        if (!arg) {
          await reply("用法: /exec <shell 命令>");
          return;
        }
        await doExec(arg);
        break;
      case "progress":
      case "pg": {
        const n = parseInt(arg, 10) || 10;
        await reply(progressText(n));
        break;
      }
      case "screenshot":
      case "sc":
        await doScreenshot();
        break;
      case "quiet":
      case "q":
        if (arg === "on" || arg === "1") config.autoReport = true;
        else if (arg === "off" || arg === "0") config.autoReport = false;
        await reply(`进度自动汇报: ${config.autoReport ? "开 ✅" : "关 ⏸️"}`);
        break;
      default:
        await reply(`❓ 未知命令 ${cmd}。发送 /help 查看命令。`);
    }
  }

  function helpText() {
    return [
      "🤖 DSH QQ 远程控制",
      "/ask <任务>   派发任务（私聊直接发消息也可）      /task",
      "/exec <命令>  在电脑上执行 shell 命令              /run",
      "/status       查看 agent 状态                     /st",
      "/progress [n] 查看最近进度（默认 10 条）          /pg",
      "/screenshot   截图并发送给你                      /sc",
      "/cancel       取消当前任务                        /x",
      "/sessions     列出会话（含标题）                  /ss",
      "/session <标题|id> 切换目标会话                  /s",
      "/title <名称>  给当前目标会话重命名",
      "/newsession <id> 新建会话并切换                  /ns",
      "/quiet on|off 开关进度自动推送                    /q",
      "/chat on|off  纯净聊天模式（/chat <名字> 切换）",
      "/chatbind on|off 绑定聊天特化会话                 /cb",
      "/panel        打开 QQ 控制面板                    /pn",
      "/ping         连通性测试（/pong 亦可）",
      "/help         本帮助（/h 亦可）",
    ].join("\n");
  }

  // ── Agent 桥接 ────────────────────────────────────────────────
  function agentsService() {
    return ctx.get("agents");
  }

  /** 解析目标 agent：配置 sessionId → 最近活跃会话。 */
  function resolveAgent() {
    const agents = agentsService();
    if (!agents) return null;
    if (config.targetSessionId) {
      const a = agents.get(config.targetSessionId);
      if (a) return a;
    }
    const list = agents.list();
    if (list.length === 0) return null;
    list.sort((a, b) => (lastEventAt.get(b.session.id) ?? 0) - (lastEventAt.get(a.session.id) ?? 0));
    return list[0];
  }

  /** 当前 agent 轮次数。 */
  function agentTurn(agent) {
    return agent.session.events.filter((e) => e.type === "turn/start").length;
  }

  /** 读取会话标题（无标题返回 undefined）。get() 返回 {title,...} 对象或字符串。 */
  function sessionTitleOf(session) {
    try {
      const t = ctx.get("sessionTitle")?.get(session);
      if (t === undefined || t === null) return undefined;
      return typeof t === "string" ? t : t.title;
    } catch {
      return undefined;
    }
  }

  /** 按标题包含匹配 agent（返回 [{agent, title}]）。 */
  function matchAgentsByTitle(query) {
    const agents = agentsService();
    if (!agents) return [];
    const out = [];
    for (const a of agents.list()) {
      const title = sessionTitleOf(a.session);
      if (title && title.includes(query)) out.push({ agent: a, title });
    }
    return out;
  }

  /** /session 无参时的用法提示（含当前目标标题）。 */
  function sessionUsage() {
    const agents = agentsService();
    const list = agents ? agents.list() : [];
    const lines = ["用法: /session <序号|标题|id>"];
    if (config.targetSessionId) {
      const i = list.findIndex((a) => a.session.id === config.targetSessionId);
      if (i >= 0) {
        const title = sessionTitleOf(list[i].session) ?? "未命名";
        lines.push(`当前目标: ${i + 1}. 「${title}」 ${config.targetSessionId}`);
      } else {
        lines.push(`当前目标: ${config.targetSessionId}`);
      }
    } else {
      lines.push("当前目标: 自动-最近活跃（/sessions 查看列表）");
    }
    return lines.join("\n");
  }

  /** 切换目标会话：优先序号，其次 id 精确，最后标题包含匹配。 */
  async function doSwitchSession(query) {
    const agents = agentsService();
    const list = agents ? agents.list() : [];
    // 1) 序号（/sessions 列表中的 1-based 序号）
    const idx = Number.parseInt(query, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) {
      const target = list[idx - 1];
      config.targetSessionId = target.session.id;
      const title = sessionTitleOf(target.session);
      await reply(`✅ 已切换到 ${idx}. ${title ? `「${title}」` : target.session.id}`);
      return;
    }
    // 2) id 精确
    if (agents) {
      const byId = agents.get(query);
      if (byId) {
        config.targetSessionId = query;
        await reply(`✅ 目标会话已设为 ${query}`);
        return;
      }
    }
    // 3) 标题包含匹配
    const hits = matchAgentsByTitle(query);
    if (hits.length === 1) {
      config.targetSessionId = hits[0].agent.session.id;
      await reply(`✅ 已按标题「${hits[0].title}」切换到 ${hits[0].agent.session.id}`);
      return;
    }
    if (hits.length > 1) {
      await reply(`🔀 标题「${query}」匹配到多个会话，请用序号或更精确的标题：\n` +
        hits.map((h) => `• 「${h.title}」`).join("\n"));
      return;
    }
    await reply(`❌ 未找到「${query}」（/sessions 看序号列表）`);
  }

  /** 给当前目标会话重命名。 */
  async function doTitle(title) {
    const agent = resolveAgent();
    if (!agent) {
      await reply("❌ 没有可用的 agent 会话");
      return;
    }
    const st = ctx.get("sessionTitle");
    if (!st) {
      await reply("❌ sessionTitle 服务不可用");
      return;
    }
    try {
      const snap = st.rename(agent.session, title);
      await reply(`✅ 已重命名: 「${snap.title}」（${agent.session.id}）\n之后可用 /session ${snap.title} 切换`);
    } catch (e) {
      await reply(`⚠️ 重命名失败: ${e.message}`);
    }
  }

  // ── 纯净聊天模式：持久化 + 多聊天会话 ─────────────────────────
  const CHAT_DIR = path.join(os.homedir(), ".dsh", "qq-remote-chats");
  const CHAT_NAME_RE = /^[\w\u4e00-\u9fa5-]{1,32}$/;

  function chatPath(name) {
    return path.join(CHAT_DIR, name + ".json");
  }

  /** 加载（或新建）一个聊天会话的记忆。 */
  function loadChat(name) {
    if (chats.has(name)) return chats.get(name);
    let arr = [];
    try {
      const p = chatPath(name);
      if (fs.existsSync(p)) arr = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      log.warn(`[qq-remote] 读取聊天记忆失败(${name}): ${e.message}`);
    }
    if (!Array.isArray(arr)) arr = [];
    chats.set(name, arr);
    return arr;
  }

  /** 保存一个聊天会话的记忆到磁盘。 */
  function saveChat(name) {
    try {
      fs.mkdirSync(CHAT_DIR, { recursive: true });
      fs.writeFileSync(chatPath(name), JSON.stringify(chats.get(name) ?? []));
    } catch (e) {
      log.warn(`[qq-remote] 保存聊天记忆失败(${name}): ${e.message}`);
    }
  }

  /** 列出磁盘上的所有聊天会话。 */
  function listChatNames() {
    try {
      if (!fs.existsSync(CHAT_DIR)) return [];
      return fs.readdirSync(CHAT_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  /** 当前目标会话是否"聊天特化"（私聊消息直接聊天回复，不走任务）。 */
  function isChatTarget() {
    if (!config.targetSessionId) return false;
    const agents = agentsService();
    const a = agents?.get(config.targetSessionId);
    if (!a) return false;
    const title = sessionTitleOf(a.session) ?? config.targetSessionId;
    return config.chatSessionNames.includes(title) || config.chatSessionNames.includes(config.targetSessionId);
  }

  /** 聊天记忆的会话名：聊天特化会话用其标题/id，否则用当前 /chat 会话。 */
  function chatNameFor() {
    if (config.targetSessionId) {
      const agents = agentsService();
      const a = agents?.get(config.targetSessionId);
      if (a) return sessionTitleOf(a.session) ?? config.targetSessionId;
    }
    return chatName;
  }

  /** 把聊天特化名单持久化到 ~/.dsh/qq-remote.json（重启后保留）。 */
  function persistChatSessionNames() {
    try {
      const p = path.join(os.homedir(), ".dsh", "qq-remote.json");
      const overlay = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
      overlay.chatSessionNames = config.chatSessionNames;
      fs.writeFileSync(p, JSON.stringify(overlay, null, 2));
    } catch (e) {
      log.warn(`[qq-remote] 持久化聊天特化名单失败: ${e.message}`);
    }
  }

  /** 绑定/解绑当前目标会话为聊天特化。 */
  async function doChatBind(arg) {
    const agents = agentsService();
    const a = config.targetSessionId ? agents?.get(config.targetSessionId) : null;
    if (!a) {
      await reply("❌ 请先设置目标会话（/session <序号|标题|id>）再绑定");
      return;
    }
    const title = sessionTitleOf(a.session) ?? config.targetSessionId;
    const on = arg !== "off" && arg !== "0";
    if (on) {
      if (!config.chatSessionNames.includes(title)) config.chatSessionNames.push(title);
      persistChatSessionNames();
      await reply(`💗 会话「${title}」已绑定为聊天特化\n发消息 = 直接聊天回复（像真人 QQ，不走任务/不推进度）\n/chatbind off 可解除`);
    } else {
      config.chatSessionNames = config.chatSessionNames.filter((n) => n !== title && n !== config.targetSessionId);
      persistChatSessionNames();
      await reply(`🔧 会话「${title}」已解除聊天特化，恢复任务模式`);
    }
  }

  /** 纯净聊天模式开关。 */
  async function doChatMode(arg) {
    if (arg === "on" || arg === "1") {
      loadChat(chatName);
      chatMode = true;
      await reply(`💬 纯净聊天模式已开启（会话「${chatName}」）！直接发消息聊天（/chat off 退出，/chat <名字> 切换会话）`);
    } else if (arg === "off" || arg === "0") {
      saveChat(chatName);
      chatMode = false;
      await reply("✅ 纯净聊天模式已关闭，恢复任务/命令模式");
    } else if (arg === "clear") {
      chats.set(chatName, []);
      saveChat(chatName);
      await reply(`🧹 聊天会话「${chatName}」的记忆已清空`);
    } else if (arg === "list") {
      const names = listChatNames();
      await reply(`📚 聊天会话${names.length ? ":\n" + names.map((n) => `• ${n}${n === chatName ? "（当前）" : ""}`).join("\n") : ":（暂无）"}`);
    } else if (arg) {
      if (!CHAT_NAME_RE.test(arg)) {
        await reply("⚠️ 会话名只能含中文/字母/数字/横线，且不超过 32 字");
        return;
      }
      saveChat(chatName); // 保存当前会话
      chatName = arg;
      loadChat(chatName);
      chatMode = true;
      const count = chats.get(chatName).length;
      await reply(`💬 已切换到聊天会话「${arg}」${count > 0 ? `（记忆 ${count} 条）` : "（新会话）"}，直接发消息聊天吧`);
    } else {
      const count = loadChat(chatName).length;
      await reply(`💬 纯净聊天模式: ${chatMode ? "开 ✅" : "关"}｜当前会话「${chatName}」（记忆 ${count} 条）\n/chat on 开启 / /chat <名字> 切换 / /chat list 列表 / /chat clear 清空 / /chat off 退出`);
    }
  }

  /** 纯净聊天：直接调 LLM 像人一样回复（不走任务/工具/进度推送）。 */
  async function chatReply(text) {
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (!selection?.provider || !selection?.model) {
      await reply("❌ 无法获取默认模型（请先在 DSH 配置模型）");
      return;
    }
    const name = chatNameFor();
    const history = loadChat(name);
    // 消息必须带 source（dsh-llm 的 forAdapter 会访问 assistant 消息的 source.kind）
    history.push({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
    // 上下文：默认全量（chatHistoryLimit/chatMaxChars 为 0 时不截断）
    let send = history;
    if (config.chatHistoryLimit > 0) send = history.slice(-config.chatHistoryLimit);
    if (config.chatMaxChars > 0) {
      let budget = 0;
      for (let i = send.length - 1; i >= 0; i--) {
        budget += (send[i].content?.[0]?.text ?? "").length;
        if (budget > config.chatMaxChars) {
          send = send.slice(i + 1);
          break;
        }
      }
    }
    const messages = [
      { role: "system", source: { kind: "system" }, content: [{ type: "text", text: config.chatSystemPrompt }] },
      ...send,
    ];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90000);
    let out = "";
    try {
      const stream = ctx.get("llm").stream({
        provider: selection.provider,
        model: selection.model,
        messages,
        signal: ac.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === "text-delta") out += chunk.text;
        else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
          throw new Error(chunk.reason.failure?.message ?? "模型调用失败");
        }
      }
    } catch (e) {
      clearTimeout(timer);
      history.pop(); // 回滚失败的用户消息
      const hint = /context|窗口|token/i.test(e.message) ? "\n💡 可能上下文太长：/chat clear 清空记忆，或在配置里设 chatHistoryLimit/chatMaxChars" : "";
      await reply(`⚠️ 对话出错: ${e.message}${hint}`);
      return;
    }
    clearTimeout(timer);
    const clean = out.trim();
    history.push({
      role: "assistant",
      source: { kind: "model", provider: selection.provider, model: selection.model },
      content: [{ type: "text", text: clean || "（无回复）" }],
    });
    saveChat(name);
    await reply(clean || "（无回复）");
  }

  async function doAsk(task) {
    const agent = resolveAgent();
    if (!agent) {
      await reply("❌ 没有可用的 agent 会话（/sessions 查看，/session <id> 指定）");
      return;
    }
    const startTurn = agentTurn(agent);
    activeTask = { sessionId: agent.session.id, startTurn, startedAt: Date.now() };
    agent.followup(createUserMessage({
      content: [{ type: "text", text: task }],
      source: { kind: "user" },
    }));
    await reply([
      `✅ 任务已派发\n📌 会话: ${agent.session.id}\n📝 任务: ${truncate(task, 200)}`,
      `🔔 进度将自动回传（/quiet off 可关），/cancel 可取消，/screenshot 可看屏幕。`,
    ].join("\n"));
  }

  async function doCancel() {
    const agent = resolveAgent();
    if (!agent) {
      await reply("❌ 没有可用的 agent 会话");
      return;
    }
    try {
      agent.cancel("qq-remote: 用户在 QQ 上取消");
      await reply("⏹️ 已发送取消指令");
    } catch (e) {
      await reply(`⚠️ 取消失败: ${e.message}`);
    }
  }

  /** 在当前工作区新建 agent 会话并切换目标。
   *  注意：必须在根上下文（ctx.root）调用 agents.create —— 否则 agent 生命周期
   *  绑定在插件 fiber 上，插件一重载/重注入会话就会被销毁。 */
  async function doNewSession(id) {
    const agents = ctx.root.get("agents");
    if (!agents) {
      await reply("❌ agents 服务不可用");
      return;
    }
    if (agents.get(id)) {
      await reply(`❌ 会话已存在: ${id}（可直接 /session ${id} 切换）`);
      return;
    }
    const current = resolveAgent();
    const cwd = config.execCwd || current?.session?.header?.cwd || process.cwd();
    let selection;
    try {
      selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    } catch {}
    try {
      const { agent } = await agents.create({
        sessionId: id,
        meta: { cwd },
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
      });
      // 新会话默认以 id 为标题（之后可用 /title 修改）
      try {
        ctx.get("sessionTitle")?.rename(agent.session, id);
      } catch {}
      config.targetSessionId = id;
      await reply([
        "✅ 已新建会话并切换目标",
        `📌 session: ${agent.session.id}`,
        `🏷️ 标题: ${id}（可用 /title <名称> 修改）`,
        `📂 cwd: ${cwd}`,
        `🤖 模型: ${selection ? `${selection.provider}/${selection.model}` : "默认"}`,
        "现在 /ask <任务> 将派发到该会话",
      ].join("\n"));
    } catch (e) {
      await reply(`⚠️ 新建会话失败: ${e.message}`);
    }
  }

  async function doExec(cmd) {
    const agent = resolveAgent();
    let cwd = config.execCwd || agent?.session?.header?.cwd || process.cwd();
    if (!fs.existsSync(cwd)) cwd = process.cwd();
    await reply(`⚙️ 执行中（cwd=${cwd}，超时 ${Math.round(config.execTimeoutMs / 1000)}s）…\n$ ${truncate(cmd, 300)}`);
    const res = await runProcess("/bin/bash", ["-c", cmd], { timeout: config.execTimeoutMs, cwd });
    const out = [res.out, res.err].filter((s) => s && s.trim()).join("\n");
    const head = res.timedOut ? "⏱️ 超时已终止（SIGKILL）" : `exit=${res.code ?? res.signal}`;
    await reply(`${head}\n${out ? truncate(out, config.maxMessageLen - 100) : "（无输出）"}`);
  }

  async function doScreenshot() {
    await reply("📸 正在截取屏幕…");
    try {
      const shot = await takeScreenshot(config);
      await sendImage(controller.userId, controller.groupId, shot.base64, `📸 屏幕截图 (${Math.round(fs.statSync(shot.file).size / 1024)}KB)`);
    } catch (e) {
      await reply(`⚠️ 截图失败: ${e.message}`);
    }
  }

  function statusText() {
    const agent = resolveAgent();
    if (!agent) return "❌ 没有可用的 agent 会话";
    const phase = agent.phase;
    const lines = [
      `📊 会话: ${agent.session.id}`,
      `状态: ${agent.status}${phase?.kind === "running" ? `（第 ${phase.turn} 轮 / 第 ${phase.step} 步）` : ""}`,
      `模型: ${agent.options?.provider}/${agent.options?.model ?? "?"}`,
    ];
    if (agent.status === "running" && phase?.kind === "running") {
      const recent = agent.session.events.slice(-30).reverse().find((e) =>
        e.type === "tool/call" || e.type === "assistant/message");
      if (recent) {
        lines.push(recent.type === "tool/call"
          ? `正在: 🔧 ${recent.data.name}`
          : `正在: 🤖 ${truncate(extractAssistantText(recent.data.message), 200)}`);
      }
    }
    const last = [...agent.session.events].reverse().find((e) => e.type === "turn/end");
    if (last) lines.push(`最近一轮: 第 ${last.data.turn} 轮 [${last.data.reason?.kind}]`);
    if (activeTask) lines.push(`跟踪任务: 进行中（${Math.round((Date.now() - activeTask.startedAt) / 1000)}s）`);
    return lines.join("\n");
  }

  function sessionsText() {
    const agents = agentsService();
    if (!agents) return "❌ agents 服务不可用";
    const list = agents.list();
    if (list.length === 0) return "❌ 当前没有 agent 会话";
    const lines = [`📋 会话列表（${list.length} 个）:`];
    list.forEach((a, i) => {
      const title = sessionTitleOf(a.session) ?? "未命名";
      const status = a.status === "running" ? "进行中" : "空闲";
      const mark = a.session.id === config.targetSessionId ? " 🎯" : "";
      lines.push(`${i + 1}. 「${title}」 ${a.session.id} [${status}] 第 ${agentTurn(a)} 轮${mark}`);
    });
    lines.push("💡 /session <序号|标题|id> 切换");
    return lines.join("\n");
  }

  function progressText(n) {
    const agent = resolveAgent();
    if (!agent) return "❌ 没有可用的 agent 会话";
    const interesting = agent.session.events.filter((e) => formatEventLine(e));
    const tail = interesting.slice(-n);
    if (tail.length === 0) return "📭 暂无进度事件";
    const lines = tail.map((e) => formatEventLine(e));
    return `📜 最近 ${tail.length} 条进度:\n` + lines.join("\n");
  }

  // ── 进度推送 ──────────────────────────────────────────────────
  function enqueueReport(line) {
    if (!config.autoReport || !controller || disposed) return;
    pendingReports.push(line);
    const now = Date.now();
    const wait = Math.max(0, config.reportThrottleMs - (now - lastReportAt));
    if (wait === 0) return flushReports();
    if (!pendingTimer) pendingTimer = setTimeout(flushReports, wait);
  }

  async function flushReports() {
    pendingTimer = null;
    if (pendingReports.length === 0 || disposed) return;
    let lines = pendingReports;
    pendingReports = [];
    if (lines.length > 3) {
      lines = [...lines.slice(0, 2), `…（另有 ${lines.length - 2} 条进展，/progress 查看）`];
    }
    lastReportAt = Date.now();
    try {
      await reply(lines.join("\n"));
    } catch (e) {
      log.warn(`[qq-remote] 进度推送失败: ${e.message}`);
    }
  }

  /** 直接发送一条汇报（phase 模式用，低频不节流）。 */
  async function sendReport(text) {
    if (!config.autoReport || !controller || disposed) return;
    try {
      await reply(text);
    } catch (e) {
      log.warn(`[qq-remote] 汇报发送失败: ${e.message}`);
    }
  }

  // ── phase 模式：阶段性总结汇报 ────────────────────────────────
  /** 当前轮次的阶段收集器。 */
  let phaseState = null;
  let heartbeatTimer = null;

  function resetPhaseState() {
    phaseState = {
      turn: 0,
      step: 0,
      toolCalls: 0,
      lastTools: [],
      lastAssistant: "",
      startedAt: Date.now(),
    };
  }

  function noteTool(name, args) {
    if (!phaseState) resetPhaseState();
    phaseState.toolCalls += 1;
    let brief = name;
    try {
      brief = `${name}(${truncate(JSON.stringify(args ?? {}), 80)})`;
    } catch {}
    phaseState.lastTools.push(brief);
    if (phaseState.lastTools.length > 3) phaseState.lastTools.shift();
  }

  /** 轮次小结。 */
  async function phaseTurnSummary(event) {
    const st = phaseState;
    if (!st) return;
    const secs = Math.round((Date.now() - st.startedAt) / 1000);
    const lines = [`📊 第 ${event.data.turn} 轮小结（用时 ${secs}s）`];
    if (st.toolCalls > 0) lines.push(`🔧 工具调用 ${st.toolCalls} 次${st.lastTools.length ? "：" + st.lastTools.join("、") : ""}`);
    if (st.lastAssistant) lines.push(`🤖 ${truncate(st.lastAssistant, 200)}`);
    lines.push(`状态: ${event.data.reason?.kind ?? "?"}`);
    await sendReport(lines.join("\n"));
  }

  /** 任务完成总结。 */
  async function phaseTaskSummary(session, task, endEvent) {
    const st = phaseState;
    const secs = Math.round((Date.now() - task.startedAt) / 1000);
    const reason = endEvent.data.reason;
    const kind = reason?.kind ?? "?";
    // 找任务开始后的最后一条 assistant 文本
    const events = session.events;
    const startIdx = events.findIndex((e) => e.type === "turn/start" && e.data.turn === task.startTurn + 1);
    let finalText = "";
    if (startIdx >= 0) {
      for (const e of events.slice(startIdx)) {
        if (e.type === "assistant/message") {
          const t = extractAssistantText(e.data.message);
          if (t) finalText = t;
        }
      }
    }
    const lines = [
      kind === "completed" ? "✅ 任务完成" : kind === "error" ? "❌ 任务出错" : `🏁 任务结束 [${kind}]`,
      finalText ? `📄 结果: ${truncate(finalText, 600)}` : "",
      `⏱️ 用时 ${secs}s${st && st.toolCalls > 0 ? `，工具调用 ${st.toolCalls} 次` : ""}（/progress 看详情）`,
    ].filter(Boolean).join("\n");
    await sendReport(lines);
  }

  /** 长任务心跳汇报。 */
  async function phaseHeartbeat() {
    if (!activeTask) return;
    const agent = resolveAgent();
    const mins = Math.round((Date.now() - activeTask.startedAt) / 60000);
    const st = phaseState;
    const lines = [`⏳ 任务进行中（已 ${mins} 分钟）`];
    if (agent?.phase?.kind === "running") lines.push(`• 第 ${agent.phase.turn} 轮 / 第 ${agent.phase.step} 步`);
    if (st?.lastTools.length) lines.push(`• 最近: 🔧 ${st.lastTools.at(-1)}`);
    if (st?.lastAssistant) lines.push(`• 🤖 ${truncate(st.lastAssistant, 120)}`);
    await sendReport(lines.join("\n"));
  }

  function startHeartbeat() {
    if (disposed || heartbeatTimer || !config.autoReport) return;
    heartbeatTimer = setInterval(() => {
      phaseHeartbeat().catch(() => {});
    }, Math.max(config.phaseIntervalMs, 30000));
  }

  /** phase 模式事件处理：收集 + 阶段触发。 */
  function handlePhaseEvent(session, event) {
    const watchId = activeTask?.sessionId ?? resolveAgent()?.session?.id;
    if (!watchId || session.id !== watchId) return;

    // 任务完成检测：track 的会话轮次推进 → 汇总最终结果
    if (activeTask && event.type === "turn/end" && event.data.turn >= activeTask.startTurn + 1) {
      const task = activeTask;
      activeTask = null;
      phaseTaskSummary(session, task, event).catch(() => {});
      return;
    }

    switch (event.type) {
      case "turn/start":
        resetPhaseState();
        phaseState.turn = event.data.turn;
        break;
      case "step/start":
        if (!phaseState) resetPhaseState();
        phaseState.step = event.data.step;
        break;
      case "tool/call":
        noteTool(event.data.name, event.data.arguments);
        break;
      case "tool/result": {
        const block = event.data.message?.content?.[0];
        if (block?.isError || event.data.error) {
          // 出错即时汇报（重要异常不等阶段总结）
          const errText = truncate(block?.content?.[0]?.text ?? event.data.error?.message ?? "未知错误", 200);
          sendReport(`⚠️ 工具出错: ${errText}`).catch(() => {});
        }
        break;
      }
      case "assistant/message": {
        const t = extractAssistantText(event.data.message);
        if (t && phaseState) phaseState.lastAssistant = t;
        break;
      }
      case "turn/end":
        // 无跟踪任务时的轮次小结（有任务时上面已走完成总结）
        phaseTurnSummary(event).catch(() => {});
        break;
      default:
        break;
    }
  }

  /** session/event 观察者：记录活跃度 + 按模式生成汇报。 */
  function onSessionEvent(session, event) {
    lastEventAt.set(session.id, Date.now());
    if (config.reportMode === "phase") {
      handlePhaseEvent(session, event);
      return;
    }
    // live 模式：实时流水（原逻辑）
    const watchId = activeTask?.sessionId ?? resolveAgent()?.session?.id;
    if (!watchId || session.id !== watchId) return;

    // 任务完成检测：track 的会话轮次推进 → 汇总最终结果
    if (activeTask && event.type === "turn/end" && event.data.turn >= activeTask.startTurn + 1) {
      const task = activeTask;
      activeTask = null;
      const reason = event.data.reason;
      const kind = reason?.kind ?? "?";
      // 找任务开始后的最后一条 assistant 文本
      const events = session.events;
      const startIdx = events.findIndex((e) => e.type === "turn/start" && e.data.turn === task.startTurn + 1);
      let finalText = "";
      if (startIdx >= 0) {
        for (const e of events.slice(startIdx)) {
          if (e.type === "assistant/message") {
            const t = extractAssistantText(e.data.message);
            if (t) finalText = t;
          }
        }
      }
      const report = [
        kind === "completed" ? "✅ 任务完成" : kind === "error" ? "❌ 任务出错" : `🏁 任务结束 [${kind}]`,
        finalText ? `📄 结果: ${truncate(finalText, 600)}` : "",
        `⏱️ 用时 ${Math.round((Date.now() - task.startedAt) / 1000)}s（/progress 查看更多）`,
      ].filter(Boolean).join("\n");
      enqueueReport(report);
      return;
    }

    const line = formatEventLine(event);
    if (line) enqueueReport(line);
  }

  // ── Agent 可用工具（会话内主动汇报 / 截图） ───────────────────
  function registerTools() {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: "qq_report",
      description: "向远程 QQ 控制端发送一条文本消息（进度汇报、结果摘要、需要用户确认的问题）。仅当有 QQ 控制端绑定（用户通过 QQ 发过命令）时可用。",
      parameters: {
        text: { type: "string", required: true, description: "要发送给 QQ 用户的文本" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            note: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.note }],
      },
      async execute(args) {
        if (!controller) return { ok: false, note: "没有绑定的 QQ 控制端（用户尚未通过 QQ 发过命令）" };
        try {
          await sendText(controller.userId, controller.groupId, truncate(args.text, config.maxMessageLen));
          return { ok: true, note: "已通过 QQ 发送" };
        } catch (e) {
          return { ok: false, note: `QQ 发送失败: ${e.message}` };
        }
      },
    })));

    ctx.effect(() => ctx.tools.register(defineTool({
      name: "qq_screenshot",
      description: "截取电脑屏幕，并把截图作为图片消息发送给远程 QQ 控制端。用于向用户展示当前界面状态。",
      parameters: {
        caption: { type: "string", description: "附加在截图前的说明文字（可选）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            note: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.note }],
      },
      async execute(args) {
        if (!controller) return { ok: false, note: "没有绑定的 QQ 控制端（用户尚未通过 QQ 发过命令）" };
        try {
          const shot = await takeScreenshot(config);
          await sendImage(controller.userId, controller.groupId, shot.base64, args.caption ? `📸 ${args.caption}` : undefined);
          return { ok: true, note: "截图已发送到 QQ" };
        } catch (e) {
          return { ok: false, note: `截图失败: ${e.message}` };
        }
      },
    })));
  }

  // ── QQ 图形开关面板（Web 页面：状态 + 重新登录 + 二维码） ──────
  /** 登录二维码候选路径（自动探测常见 NapCat 安装位置；可用 qrcodePath 配置覆盖）。 */
  const QR_CANDIDATES = () => {
    const home = os.homedir();
    const list = [
      path.join(home, "napcat", "cache", "qrcode.png"),
      "/opt/QQ/resources/app/napcat/cache/qrcode.png",
      "/opt/QQNT/resources/app/napcat/cache/qrcode.png",
      path.join(home, ".config", "QQ", "NapCat", "cache", "qrcode.png"),
    ];
    if (config.qrcodePath) list.unshift(config.qrcodePath);
    return list;
  };

  function findQrcode() {
    for (const p of QR_CANDIDATES()) {
      try {
        if (fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs < 10 * 60 * 1000) return p;
      } catch {}
    }
    return null;
  }

  async function qqLoggedIn() {
    try {
      const info = await api("get_login_info", {}, 5000);
      return Boolean(info?.user_id);
    } catch {
      return false;
    }
  }

  function json(res, data) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  function panelHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QQ 远程控制 · DSH</title>
<style>
  body{background:#0f1420;color:#e8eaf0;font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#171e2e;border:1px solid #26304a;border-radius:16px;padding:32px 36px;width:min(420px,92vw);box-shadow:0 12px 40px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
  .sub{color:#8b93a7;font-size:13px;margin-bottom:20px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #222c44;font-size:14px}
  .row:last-of-type{border-bottom:none}
  .badge{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .ok{background:#12331f;color:#4ade80}.bad{background:#3a1620;color:#f87171}.wait{background:#332b12;color:#facc15}
  button{width:100%;margin-top:18px;padding:12px;border:none;border-radius:10px;background:#4d6bfe;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#5b77ff}button:disabled{background:#2a3350;color:#6b7280;cursor:not-allowed}
  button.danger{background:#b91c1c}button.danger:hover{background:#dc2626}
  #qrwrap{display:none;margin-top:18px;text-align:center}
  #qrwrap img{width:240px;height:240px;border-radius:12px;background:#fff;padding:10px}
  #qrhint{color:#8b93a7;font-size:12px;margin-top:8px}
  #log{color:#64748b;font-size:12px;margin-top:14px;min-height:16px}
</style></head><body>
<div class="card">
  <h1>🤖 QQ 远程控制</h1>
  <div class="sub">dsh-qq-remote 控制面板</div>
  <div class="row"><span>插件连接</span><span id="st-ws" class="badge wait">检测中…</span></div>
  <div class="row"><span>QQ 登录状态</span><span id="st-qq" class="badge wait">检测中…</span></div>
  <button id="btn" disabled>检测中…</button>
  <div id="qrwrap"><img id="qr" alt="登录二维码"><div id="qrhint"></div></div>
  <div id="log"></div>
</div>
<script>
const $=id=>document.getElementById(id);
let polling=false, qrTimer=null;
async function refresh(){
  try{
    const r=await fetch('/qq-remote/status');const s=await r.json();
    $('st-ws').textContent=s.wsConnected?'已连接':'未连接';
    $('st-ws').className='badge '+(s.wsConnected?'ok':'bad');
    $('st-qq').textContent=s.loggedIn?'已登录':'未登录';
    $('st-qq').className='badge '+(s.loggedIn?'ok':'bad');
    const b=$('btn');
    b.disabled=false;
    if(s.loggedIn){b.textContent='✅ QQ 已登录（需要重登点这里）';b.className='';}
    else if(s.qrAvailable){b.textContent='🔄 重新登录（二维码已就绪）';b.className='danger';}
    else{b.textContent='🔄 重新登录（弹出二维码）';b.className='danger';}
    if(polling&&s.qrAvailable)showQr();
    if(polling&&s.loggedIn){stopPoll();log('✅ 登录成功');}
    if(!s.loggedIn&&s.qrAvailable)showQr();
  }catch(e){log('状态获取失败: '+e.message);}
}
function showQr(){
  $('qrwrap').style.display='block';
  $('qr').src='/qq-remote/qrcode?t='+Date.now();
  $('qrhint').textContent='手机 QQ 扫码授权（二维码约 2 分钟有效，过期自动刷新）';
}
function stopPoll(){polling=false;clearInterval(qrTimer);}
$('btn').onclick=async()=>{
  const b=$('btn');b.disabled=true;b.textContent='正在重启 NapCat…';
  log('触发重新登录…');
  try{await fetch('/qq-remote/relogin',{method:'POST'});}catch(e){}
  log('等待二维码/自动登录…（NapCat 重启中，约 30-60 秒）');
  $('qrwrap').style.display='none';
  polling=true;qrTimer=setInterval(refresh,3000);
};
refresh();setInterval(refresh,5000);
</script></body></html>`;
  }

  function registerQqPanel() {
    const webServer = ctx.get("webServer");
    if (!webServer) return;
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/panel",
      handler: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(panelHtml());
      },
    }), "qq-remote: panel");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/status",
      handler: async (_req, res) => {
        const [loggedIn, qr] = await Promise.all([
          qqLoggedIn().catch(() => false),
          Promise.resolve(findQrcode()),
        ]);
        json(res, {
          loggedIn,
          wsConnected: Boolean(ws && ws.readyState === WebSocket.OPEN),
          qrAvailable: Boolean(qr),
        });
      },
    }), "qq-remote: status");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/relogin",
      handler: async (_req, res) => {
        json(res, { ok: true });
        // 后台重启 NapCat：登录态有效则快速登录自动恢复，失效则自动进入二维码模式
        runProcess("systemctl", ["--user", "restart", "napcat-qq"], { timeout: 15000 }).catch(() => {});
      },
    }), "qq-remote: relogin");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/qrcode",
      handler: async (_req, res) => {
        const p = findQrcode();
        if (!p) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("no qrcode yet");
          return;
        }
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(fs.readFileSync(p));
      },
    }), "qq-remote: qrcode");
  }

  // ── 装配 ──────────────────────────────────────────────────────
  ctx.effect(() => {
    registerTools();
    registerQqPanel();
    const offEvent = ctx.on("session/event", onSessionEvent);
    connect();
    startWatchdog();
    startHeartbeat();
    return () => {
      disposed = true;
      offEvent();
      if (pendingTimer) clearTimeout(pendingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const w of waiters.values()) clearTimeout(w.timer);
      waiters.clear();
      try {
        ws?.close();
      } catch {}
      ws = null;
    };
  });
}
