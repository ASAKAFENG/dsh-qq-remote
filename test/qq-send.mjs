/**
 * qq-send.mjs — 通过 NapCat WS API 给控制端发消息（文本/图片/文件）。
 * 用法:
 *   node test/qq-send.mjs "文本内容"
 *   node test/qq-send.mjs --image /path/to.png [说明文字]
 *   node test/qq-send.mjs --file /path/to/file [说明文字]
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const TARGET = parseInt(process.env.QQ_TARGET ?? "0", 10);
const WS_URL = process.env.QQ_WS_URL ?? "ws://127.0.0.1:3001/ws";

let message;
if (args[0] === "--image" || args[0] === "--file") {
  const isImage = args[0] === "--image";
  const file = args[1];
  const caption = args.slice(2).join(" ");
  if (!file || !fs.existsSync(file)) {
    console.error("文件不存在:", file);
    process.exit(1);
  }
  const b64 = fs.readFileSync(file).toString("base64");
  message = [];
  if (caption) message.push({ type: "text", data: { text: caption } });
  message.push({
    type: isImage ? "image" : "file",
    data: isImage ? { file: `base64://${b64}` } : { file },
  });
} else {
  const text = args.join(" ");
  if (!TARGET) {
  console.error("请设置 QQ_TARGET 环境变量为目标 QQ 号");
  process.exit(1);
}
if (!text) {
    console.error("用法: node test/qq-send.mjs <文本> | --image <png> [说明] | --file <path> [说明]");
    process.exit(1);
  }
  message = [{ type: "text", data: { text } }];
}

const ws = new WebSocket(WS_URL);
const timer = setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 30000);
ws.onopen = () => {
  ws.send(JSON.stringify({
    action: "send_private_msg",
    params: { user_id: TARGET, message },
    echo: "send1",
  }));
};
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.echo === "send1") {
    clearTimeout(timer);
    console.log("发送结果:", msg.status, msg.retcode, msg.data?.message_id ?? "");
    ws.close();
    process.exit(msg.status === "ok" ? 0 : 1);
  }
};
ws.onerror = () => process.exit(1);
