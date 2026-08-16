/**
 * dsh-qq-remote — 通用工具（纯函数，零外部依赖）。
 * 从 index.js 拆分：截断 / 消息解析 / 进度格式化 / 截图 / 进程执行 / 配置覆盖层。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 截断文本到上限，附截断标记。 */
export function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[已截断，共 ${s.length} 字符]`;
}

/** 提取 OneBot 消息里的纯文本（segment 数组或 CQ 字符串）。 */
export function extractText(message) {
  if (typeof message === "string") return message.replace(/\[CQ:[^\]]*\]/g, "").trim();
  if (!Array.isArray(message)) return "";
  return message
    .filter((seg) => seg && seg.type === "text" && typeof seg.data?.text === "string")
    .map((seg) => seg.data.text)
    .join("")
    .trim();
}

/** 提取消息里的非文本媒体类型（record/image/file/video…）。 */
export function extractMediaTypes(message) {
  if (!Array.isArray(message)) return [];
  return [...new Set(
    message.map((seg) => seg?.type).filter((t) => t && !["text", "at", "face"].includes(t))
  )];
}

/** 事件类型 → 进度行（无映射返回 null）。 */
export function formatEventLine(event) {
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
export function extractAssistantText(message) {
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
export async function takeScreenshot(config) {
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
export function binAvailable(bin) {
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
export function portalScreenshot(timeoutMs) {
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
export async function readImage(uri) {
  let file = uri;
  if (file.startsWith("file://")) file = file.slice("file://".length);
  const b64 = fs.readFileSync(file).toString("base64");
  return { file, base64: b64 };
}

/** 执行进程，捕获输出。 */
export function runProcess(bin, args, { timeout = 60000, cwd } = {}) {
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
export function loadConfigOverlay() {
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
