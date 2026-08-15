/**
 * onebot-mock.mjs — 本地 OneBot 11 模拟服务端，用于端到端测试 dsh-qq-remote。
 *
 * 用法:
 *   npm i          # 安装 ws（仅测试依赖）
 *   node test/onebot-mock.mjs [port]     # 默认 3001，路径 /ws
 *
 * 交互（stdin）:
 *   msg <userId> <text>   模拟用户发来一条私聊消息
 *   gmsg <groupId> <userId> <text>   模拟群消息
 *   quit                   退出
 *
 * 行为:
 *   - 插件连上后，收到的 send_private_msg / send_group_msg 会打印；
 *     图片消息（base64://）会解码保存到 test/out/<message_id>.png
 *   - 收到的每个 action 都回 {status:"ok", retcode:0, echo}
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const PORT = parseInt(process.argv[2] ?? "3001", 10);
const OUT_DIR = path.join(import.meta.dirname, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", data: {} }));
});

const wss = new WebSocketServer({ server, path: "/ws" });
let msgId = 1000;

function sendEvent(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

wss.on("connection", (socket) => {
  console.log(`[mock] 插件已连接 (${new Date().toLocaleTimeString()})`);

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg.action) return;
    const { action, params = {}, echo } = msg;

    if (action === "send_private_msg" || action === "send_group_msg") {
      const kind = action === "send_private_msg" ? "私聊" : "群聊";
      const target = action === "send_private_msg" ? params.user_id : params.group_id;
      const segments = Array.isArray(params.message) ? params.message : [{ type: "text", data: { text: String(params.message) } }];
      const texts = segments.filter((s) => s.type === "text").map((s) => s.data.text).join("");
      const images = segments.filter((s) => s.type === "image");
      console.log(`\n─── [mock] ${kind} → ${target} ───`);
      if (texts) console.log(texts);
      for (const img of images) {
        const file = String(img.data.file ?? "");
        if (file.startsWith("base64://")) {
          const filePath = path.join(OUT_DIR, `msg_${++msgId}.png`);
          fs.writeFileSync(filePath, Buffer.from(file.slice(9), "base64"));
          console.log(`🖼  [图片已保存] ${filePath} (${fs.statSync(filePath).size} bytes)`);
        } else {
          console.log(`🖼  [图片引用] ${file.slice(0, 80)}`);
        }
      }
    } else {
      console.log(`[mock] action=${action} params=${JSON.stringify(params).slice(0, 200)}`);
    }

    socket.send(JSON.stringify({ status: "ok", retcode: 0, data: {}, echo }));
  });

  socket.on("close", () => console.log("[mock] 插件断开"));
  socket.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock] OneBot WS 服务端: ws://127.0.0.1:${PORT}/ws`);
  console.log(`[mock] stdin: msg <userId> <text> | gmsg <groupId> <userId> <text> | quit`);
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === "quit") {
    console.log("[mock] 退出");
    process.exit(0);
  }
  if (cmd === "msg" && rest.length >= 2) {
    const userId = parseInt(rest[0], 10);
    const text = rest.slice(1).join(" ");
    for (const socket of wss.clients) {
      sendEvent(socket, {
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        message_id: ++msgId,
        user_id: userId,
        message: [{ type: "text", data: { text } }],
        raw_message: text,
        self_id: 114514,
        sender: { user_id: userId, nickname: "mock-user" },
      });
    }
    console.log(`[mock] 已模拟私聊消息: ${userId}: ${text}`);
  } else if (cmd === "gmsg" && rest.length >= 3) {
    const groupId = parseInt(rest[0], 10);
    const userId = parseInt(rest[1], 10);
    const text = rest.slice(2).join(" ");
    for (const socket of wss.clients) {
      sendEvent(socket, {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: ++msgId,
        user_id: userId,
        group_id: groupId,
        message: [{ type: "text", data: { text } }],
        raw_message: text,
        self_id: 114514,
        sender: { user_id: userId, nickname: "mock-user" },
      });
    }
    console.log(`[mock] 已模拟群消息: group=${groupId} user=${userId}: ${text}`);
  } else if (cmd !== "") {
    console.log("[mock] 未知命令:", cmd);
  }
});
