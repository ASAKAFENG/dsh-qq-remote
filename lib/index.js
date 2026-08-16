/**
 * dsh-qq-remote — 通过 QQ 消息远程控制 DeepSeek Harness。
 *
 * 桥接 OneBot 11 协议（NapCat / Lagrange.OneBot / go-cqhttp / LLOneBot），
 * 零 npm 依赖（使用 Node ≥22 内置 WebSocket）。
 *
 * 模块结构（lib/）：
 *  - util.js      通用工具（截断/解析/截图/进程执行/配置覆盖层）
 *  - onebot.js    OneBot 连接层（WS + HTTP API + 看门狗）
 *  - chat.js      纯净聊天模式（持久化 + 多会话 + 聊天特化）
 *  - commands.js  消息处理 / 命令路由 / Agent 桥接 / 进度推送 / 工具
 *  - panel.js     QQ 图形面板（状态 / 重登 / 二维码自动获取 / 白名单）
 *  - qrgen.js     零依赖 QR 生成器（v1-9，PNG 输出）
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
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { loadConfigOverlay } from "./util.js";
import { createBot } from "./onebot.js";
import { createChat } from "./chat.js";
import { createCommands } from "./commands.js";
import { createPanel } from "./panel.js";

/** Cordis 插件名。 */
export const name = "qq-remote";
/** 声明注入的服务（tools 必用；agents/sessions 走 ctx.get 可选访问）。 */
export const inject = ["tools", "webServer"];

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
  phaseIntervalMs: z.number().default(5 * 60 * 1000),
  /** 进度推送节流间隔（毫秒）。 */
  reportThrottleMs: z.number().default(3000),
  /** 单条 QQ 消息最大长度（字符），超出截断。 */
  maxMessageLen: z.number().default(3500),
  /** /exec 是否允许（默认开；不需要远程命令可关）。 */
  execAllowed: z.boolean().default(true),
  /** /exec 超时（毫秒）。 */
  execTimeoutMs: z.number().default(120000),
  /** /exec 工作目录（默认取目标会话 cwd）。 */
  execCwd: z.string().default(""),
  /** 目标会话 id（agent 的 sessionId）；留空 = 最近活跃的 agent 会话。 */
  targetSessionId: z.string().default(""),
  /** 自定义截图命令（如 "grim /tmp/x.png"）；留空 = 自动探测。 */
  screenshotCommand: z.string().default(""),
  /** 断线重连间隔（毫秒）。 */
  reconnectDelayMs: z.number().default(5000),
  /** 纯净聊天模式的人设提示词。 */
  chatSystemPrompt: z.string().default("你是用户通过 QQ 联系的一位聊天伙伴。回复要像真人 QQ 聊天一样：简短自然、口语化、有来有回，不要使用列表/表格/标题等正式格式，不要提及你是 AI、模型或助手。"),
  /** 聊天模式保留的历史消息条数上限（0 = 无限制，全量发送）。 */
  chatHistoryLimit: z.number().default(0),
  /** 聊天历史总字符预算（0 = 无限制）。 */
  chatMaxChars: z.number().default(0),
  /** 聊天特化会话名单（标题或 id）：这些会话的私聊消息直接进入聊天回复，不走任务。 */
  chatSessionNames: z.array(z.string()).default([]),
  /** NapCat 登录二维码文件路径（留空自动探测常见安装位置）。 */
  qrcodePath: z.string().default(""),
  /** NapCat WebUI 端口（二维码自动获取用；默认 6099）。 */
  webuiPort: z.number().default(6099),
  /** NapCat WebUI token（留空自动从 webui.json 探测）。 */
  webuiToken: z.string().default(""),
  /** NapCat 的 systemd 用户服务名（面板"重新登录"用它重启）。 */
  napcatServiceName: z.string().default("napcat-qq"),
});

export function apply(ctx, config) {
  const log = ctx.logger ?? console;
  // 配置覆盖层：loader 传入的 schema 解析结果 + ~/.dsh/qq-remote.json
  config = { ...config, ...loadConfigOverlay() };

  // ── 共享运行时状态（模块间通过 state 交换） ──────────────────
  const state = {
    ctx,
    config,
    log,
    /** 当前 QQ 控制端（最近一条命令的发送者）。 */
    controller: null, // { userId, groupId, isPrivate }
    /** OneBot 连接状态。 */
    ws: null,
    wsSeq: 0,
    reconnectTimer: null,
    waiters: new Map(), // echo -> {resolve, reject, timer}
    lastReportAt: 0,
    pendingReports: [],
    pendingTimer: null,
    /** 每个会话最近事件时间戳（用于挑选最近活跃 agent）。 */
    lastEventAt: new Map(),
    /** 正在跟踪的任务。 */
    activeTask: null, // { sessionId, startTurn, startedAt }
    /** 纯净聊天模式开关（/chat on|off）。 */
    chatMode: false,
    /** 当前聊天会话名（每个会话一份持久化记忆）。 */
    chatName: "default",
    /** 聊天记忆：会话名 -> 消息数组（磁盘 ~/.dsh/qq-remote-chats/<name>.json）。 */
    chats: new Map(),
    /** 插件是否已停止。 */
    disposed: false,
    /** 看门狗：周期性检查连接，未连接则重连（不依赖 close 事件）。 */
    watchdogTimer: null,
    /** 面板路由是否已注册（防重试重复注册）。 */
    panelRegistered: false,
    /** phase 模式当前轮次收集器。 */
    phaseState: null,
    /** 长任务心跳定时器。 */
    heartbeatTimer: null,
    /** 模块实例（装配顺序：bot → chat → cmds → panel）。 */
    bot: null,
    chat: null,
    cmds: null,
    panel: null,
  };

  // ── 装配 ──────────────────────────────────────────────────────
  state.bot = createBot(state);
  state.chat = createChat(state);
  state.cmds = createCommands(state);
  state.panel = createPanel(state);

  ctx.effect(() => {
    state.cmds.registerTools();
    state.panel.registerQqPanel();
    const offEvent = ctx.on("session/event", state.cmds.onSessionEvent);
    state.bot.connect();
    state.bot.startWatchdog();
    state.cmds.startHeartbeat();
    return () => {
      state.disposed = true;
      offEvent();
      if (state.pendingTimer) clearTimeout(state.pendingTimer);
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.watchdogTimer) clearInterval(state.watchdogTimer);
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      for (const w of state.waiters.values()) clearTimeout(w.timer);
      state.waiters.clear();
      try {
        state.ws?.close();
      } catch {}
      state.ws = null;
    };
  });
}
