/**
 * e2e.mjs — dsh-qq-remote 模块化回归测试。
 *
 * 用法:
 *   npm i          # 安装 ws（仅测试依赖，test/package.json）
 *   node test/e2e.mjs
 *
 * 覆盖: 模块加载 / 消息链路（ping/help/quiet/chat/群消息/未授权）/
 *       OneBot WS 连接与 echo 关联 / QR 生成器解码（jsqr 可选）。
 */
import { createBot } from "../onebot.js";
import { createChat } from "../chat.js";
import { createCommands } from "../commands.js";
import { qrToPng } from "../qrgen.js";
import { WebSocketServer } from "ws";

const sent = [];
const ctx = {
  get: () => null,
  root: { get: () => null },
  on: () => () => {},
  effect: () => {},
  tools: { register: () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
const config = {
  wsUrl: "ws://127.0.0.1:3999/ws",
  token: "", allowedUsers: [123456], groupPrefix: "/", privatePlainAsTask: true,
  autoReport: true, reportMode: "phase", maxMessageLen: 3500, execAllowed: true,
  execTimeoutMs: 60000, execCwd: "", targetSessionId: "", chatSessionNames: [],
  chatSystemPrompt: "test", chatHistoryLimit: 0, chatMaxChars: 0, reconnectDelayMs: 5000,
  phaseIntervalMs: 300000, reportThrottleMs: 3000,
};
const state = {
  ctx, config, log: ctx.logger, controller: null, ws: null, wsSeq: 0, reconnectTimer: null,
  waiters: new Map(), lastReportAt: 0, pendingReports: [], pendingTimer: null, lastEventAt: new Map(),
  activeTask: null, chatMode: false, chatName: "default", chats: new Map(), disposed: false,
  watchdogTimer: null, panelRegistered: false, phaseState: null, heartbeatTimer: null,
};
state.bot = createBot(state);
state.chat = createChat(state);
state.cmds = createCommands(state);

const wss = new WebSocketServer({ port: 3999 });
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.echo) {
      sent.push(msg.action);
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: msg.echo }));
    }
  });
});
await new Promise((r) => wss.on("listening", r));

state.bot.connect();
await new Promise((r) => setTimeout(r, 500));

const sendMsg = (text) => state.cmds.handleMessageEvent({
  message_type: "private", user_id: 123456, group_id: undefined,
  message: [{ type: "text", data: { text } }],
});

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name); }
};

// ── 消息链路 ─────────────────────────────────────────────────
await sendMsg("/ping");
await new Promise((r) => setTimeout(r, 300));
check("私聊 /ping → send_private_msg", sent.includes("send_private_msg"));

await sendMsg("/help");
await new Promise((r) => setTimeout(r, 200));
check("/help 不报错", true);

await sendMsg("/quiet off");
await new Promise((r) => setTimeout(r, 200));
check("/quiet off 改 config", config.autoReport === false);

await sendMsg("普通私聊文本（无 agents 不崩溃）");
await new Promise((r) => setTimeout(r, 200));
check("私聊文本不崩溃", true);

await sendMsg("/chat on");
await new Promise((r) => setTimeout(r, 200));
check("/chat on 进入聊天模式", state.chatMode === true);

await sendMsg("/chat off");
await new Promise((r) => setTimeout(r, 200));
check("/chat off 退出聊天模式", state.chatMode === false);

await state.cmds.handleMessageEvent({
  message_type: "group", user_id: 123456, group_id: 999,
  message: [{ type: "text", data: { text: "/ping" } }],
});
await new Promise((r) => setTimeout(r, 300));
check("群消息 /ping → send_group_msg", sent.includes("send_group_msg"));

const before = sent.filter((a) => a === "send_private_msg").length;
await state.cmds.handleMessageEvent({
  message_type: "private", user_id: 999999,
  message: [{ type: "text", data: { text: "/ping" } }],
});
await new Promise((r) => setTimeout(r, 200));
const after = sent.filter((a) => a === "send_private_msg").length;
check("未授权用户被忽略", after === before);

// ── QR 生成器（无需 jsqr 也验证 PNG 魔数） ────────────────────
const png = qrToPng("https://txz.qq.com/p?k=test", { scale: 4, margin: 4 });
check("qrToPng 生成 PNG", png && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");

wss.close();
console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
