/**
 * dsh-qq-remote — NapCat 引导模块（开箱即用）。
 *
 * 链路：检测 →（缺失时）下载 NapCat.Shell → 解压 → 写 OneBot11 反向配置 →
 *      注册 systemd 用户服务 → 启动 → 面板显示二维码扫码登录。
 *
 * 说明：
 *  - 下载源为 NapCat 官方 GitHub Release 的 NapCat.Shell.zip（无头版，无需系统 QQ GUI）。
 *  - 只写缺失配置，不覆盖用户已有 OneBot 配置（幂等合并）。
 *  - systemd 服务名 dsh-napcat.service（用户级，不影响已有 napcat-qq 等）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./util.js";

/** NapCat.Shell 官方下载地址（latest 标签跟随最新版）。 */
const SHELL_ZIP_URL = "https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip";
/** 预置下载源（设置面板可选）。 */
export const NAPCAT_MIRRORS = [
  { id: "official", name: "官方 GitHub", url: SHELL_ZIP_URL },
  { id: "ghproxy", name: "gh-proxy.com 镜像", url: "https://gh-proxy.com/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip" },
  { id: "ghfast", name: "ghfast.top 镜像", url: "https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip" },
];
const SHELL_ZIP = "NapCat.Shell.zip";
/** 插件管理的安装目录（默认 ~/.dsh/napcat；可用 napcatInstallDir 覆盖）。 */
const DEFAULT_INSTALL_DIR = () => path.join(os.homedir(), ".dsh", "napcat");
/** 插件注册的 systemd 用户服务名。 */
export const SVC_NAME = "dsh-napcat.service";

/** 候选启动入口（解压后探测）。 */
const ENTRY_CANDIDATES = ["main.mjs", "napcat.mjs", "napcat.js", "main.js", "index.mjs"];

/** 需要确保存在的 OneBot11 反向配置（插入 target 的 ws 端口）。 */
function onebotEntry(port) {
  return {
    name: "dsh-qq-remote",
    enable: true,
    host: "127.0.0.1",
    port,
    messagePostFormat: "array",
    reportSelfMessage: false,
    token: "",
    debug: false,
    reconnectionInterval: 3000,
    heartInterval: 30000,
  };
}

/** systemd 用户服务模板。qq 为空则不传 -q（WebUI 模式）。 */
function serviceTemplate(dir, entryFile, qq) {
  const qqArg = qq ? ` -q ${qq}` : "";
  return `[Unit]
Description=NapCat.Shell (managed by dsh-qq-remote)
After=network.target

[Service]
Type=simple
WorkingDirectory=${dir}
ExecStart=/usr/bin/env node ${entryFile}${qqArg}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** 常见 NapCat 安装目录候选（自动探测）。显式配置 napcatInstallDir 时只信任配置值。 */
function installDirCandidates(config) {
  const home = os.homedir();
  if (config.napcatInstallDir) return [config.napcatInstallDir];
  return [
    DEFAULT_INSTALL_DIR(),
    path.join(home, "NapCat.Shell"),
    path.join(home, "qqnt", "resources", "app", "napcat"),
    path.join(home, "QQ", "resources", "app", "napcat"),
    path.join(home, "napcat"),
    path.join(home, ".local", "share", "napcat"),
  ];
}

/** 找到可用的 OneBot 入口文件（有 => 已安装）。 */
function findEntry(dir) {
  for (const name of ENTRY_CANDIDATES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/** 读取已有 onebot11.json（不存在返回空映射）。 */
function readOnebotConfig(dir) {
  const p = path.join(dir, "config", "onebot11.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return {};
}

/** 幂等合并：确保 3001 反向 WS 条目存在，不覆盖其他配置。 */
function mergeOnebotConfig(dir, port) {
  const p = path.join(dir, "config", "onebot11.json");
  const cfg = readOnebotConfig(dir);
  if (!cfg.network || typeof cfg.network !== "object") cfg.network = {};
  if (!Array.isArray(cfg.network.websocketServers)) cfg.network.websocketServers = [];
  const exists = cfg.network.websocketServers.some(
    (s) => s && (s.port === port || (s.name && s.name.includes("dsh")))
  );
  if (!exists) cfg.network.websocketServers.push(onebotEntry(port));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, p);
  return cfg;
}

/** 解压 zip：优先 unzip 命令，回退 python3（防路径穿越）。 */
async function unzipTo(zipPath, dest) {
  try {
    const r = await runProcess("unzip", ["-q", "-o", zipPath, "-d", dest], { timeout: 120000 });
    if (r.code === 0) return true;
  } catch {}
  try {
    const script = `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);z.extractall(sys.argv[2])`;
    const r = await runProcess("python3", ["-c", script, zipPath, dest], { timeout: 120000 });
    if (r.code === 0) return true;
  } catch {}
  return false;
}

/** 下载 NapCat.Shell.zip 到目标目录，返回 zip 路径（已存在则跳过）。
 *  流式下载并回报进度（onProgress(recvBytes, totalBytes)）；可配置镜像 URL。 */
async function downloadShell(cfgDir, config, onProgress) {
  const zipPath = path.join(cfgDir, SHELL_ZIP);
  try {
    if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 5 * 1024 * 1024) return zipPath;
  } catch {}
  fs.mkdirSync(cfgDir, { recursive: true });
  const url = config.napcatDownloadUrl || SHELL_ZIP_URL;
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000), redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  if (!res.body) {
    // 无流式 body（少见）：整块读
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
    return zipPath;
  }
  const total = Number(res.headers.get("content-length") || 0);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress && (received - lastReport > 512 * 1024 || done)) {
      lastReport = received;
      onProgress(received, total);
    }
  }
  fs.writeFileSync(zipPath, Buffer.concat(chunks));
  return zipPath;
}

/** systemd 用户服务状态查询（active/不存在）。 */
async function serviceState(svcName) {
  try {
    const r = await runProcess("systemctl", ["--user", "is-active", svcName], { timeout: 5000 });
    const out = String(r.out ?? "").trim();
    return { exists: r.code === 0 || out !== "inactive", active: out === "active" };
  } catch {
    return { exists: false, active: false };
  }
}

/** 创建引导模块。state: { config, log } */
export function createNapcat(state, deps = {}) {
  const { config, log } = state;
  /** deps.onProgress(steps) — 进度回调（下载百分比等实时更新，供面板轮询）。 */

  /** 检测环境：{ installedDir, entryFile, service }。 */
  async function detect() {
    const out = {
      configuredDir: config.napcatInstallDir || "",
      installedDir: null,
      entryFile: null,
      serviceName: SVC_NAME,
      serviceExists: false,
      serviceActive: false,
    };
    const svc = await serviceState(SVC_NAME);
    out.serviceExists = svc.exists;
    out.serviceActive = svc.active;
    for (const dir of installDirCandidates(config)) {
      if (findEntry(dir)) {
        out.installedDir = dir;
        out.entryFile = findEntry(dir);
        break;
      }
    }
    return out;
  }

  /**
   * 引导执行：安装（如缺）→ 配置 → 注册服务 → 启动。
   * 返回 { ok, message, steps: [{step, ok, message}] }。幂等：已满足的步骤跳过。
   * 防护：已有活跃 NapCat 服务时直接跳过（避免双实例顶号）。
   */
  async function bootstrap(wsPort = 3001, opts = {}) {
    const steps = [];
    const notify = () => deps.onProgress?.(steps);
    const push = (step, ok, message) => {
      steps.push({ step, ok, message });
      log.info(`[qq-remote] napcat bootstrap ${step}: ${ok ? "OK" : "FAIL"} — ${message}`);
      notify();
    };
    const updateLast = (message) => {
      const last = steps[steps.length - 1];
      if (last) {
        last.message = message;
        notify();
      }
    };
    try {
      // 0) 已有活跃 NapCat 服务？（防双实例顶号；测试可跳过）
      if (!opts.skipActiveCheck) {
        const pref = config.napcatServiceName || "napcat-qq";
        try {
          const r = await runProcess("systemctl", ["--user", "is-active", pref], { timeout: 5000 });
          if (String(r.out ?? "").trim() === "active") {
            push("detect", true, `已有 NapCat 服务在运行（${pref}），无需引导`);
            return { ok: true, message: "NapCat 已在运行", steps };
          }
        } catch {}
      }
      // 1) 已安装？
      let dir = null;
      for (const d of installDirCandidates(config)) {
        if (findEntry(d)) { dir = d; break; }
      }
      if (dir) {
        push("detect", true, `已发现 NapCat: ${dir}`);
      } else {
        push("detect", true, "未发现 NapCat，开始下载安装…");
        dir = config.napcatInstallDir || DEFAULT_INSTALL_DIR();
        fs.mkdirSync(dir, { recursive: true });
        // 先看目录里是否已有解压产物（上次中断）
        if (!findEntry(dir)) {
          push("install", true, "开始下载 NapCat.Shell（约 29MB，网络慢时请耐心等待）…");
          const zip = await downloadShell(path.dirname(dir), config, (recv, total) => {
            const mb = (recv / 1048576).toFixed(1);
            const pct = total ? Math.round((recv / total) * 100) : recv ? "" : "0";
            updateLast(`下载中 ${mb}MB / ${total ? (total / 1048576).toFixed(0) + "MB" : "…"}（${pct}%）…`);
          });
          updateLast("下载完成，解压中…");
          const ok = await unzipTo(zip, dir);
          if (!ok || !findEntry(dir)) {
            push("install", false, "解压失败（需要 unzip 或 python3）；请手动安装 NapCat 后再试");
            return { ok: false, message: "NapCat 安装失败", steps };
          }
        }
        push("install", true, `NapCat 已就位: ${dir}`);
      }
      // 2) 写 OneBot 配置（幂等合并）
      mergeOnebotConfig(dir, wsPort);
      push("config", true, `OneBot11 反向 WS ws://127.0.0.1:${wsPort} 已确保`);
      // 3) 注册 systemd 服务
      const entryFile = findEntry(dir);
      const qq = (config.napcatQQ || "").trim();
      const unitPath = path.join(os.homedir(), ".config", "systemd", "user", SVC_NAME);
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      const unit = serviceTemplate(dir, entryFile, qq);
      if (!fs.existsSync(unitPath) || fs.readFileSync(unitPath, "utf8") !== unit) {
        const tmp = unitPath + ".tmp";
        fs.writeFileSync(tmp, unit);
        fs.renameSync(tmp, unitPath);
      }
      await runProcess("systemctl", ["--user", "daemon-reload"], { timeout: 10000 });
      await runProcess("systemctl", ["--user", "enable", SVC_NAME], { timeout: 10000 });
      push("service", true, qq
        ? `systemd 服务 ${SVC_NAME} 已注册（QQ ${qq} 快速登录）`
        : `systemd 服务 ${SVC_NAME} 已注册（未配置 QQ 号，WebUI 模式）`);
      if (!qq) {
        push("hint", true, "提示：未配置机器人 QQ 号，NapCat 不会生成登录二维码。请在设置「QQ 远程」面板填写机器人 QQ 号（napcatQQ）后重新引导，或在 NapCat WebUI 中添加账号。");
      }
      // 4) 启动
      const st = await serviceState(SVC_NAME);
      if (!st.active) {
        await runProcess("systemctl", ["--user", "start", SVC_NAME], { timeout: 15000 });
      }
      const st2 = await serviceState(SVC_NAME);
      if (!st2.active) {
        push("start", false, "服务启动失败，请查看 `systemctl --user status " + SVC_NAME + "`");
        return { ok: false, message: "NapCat 服务启动失败", steps };
      }
      push("start", true, "NapCat 已启动，等待扫码登录（面板二维码自动出现）");
      return { ok: true, message: "NapCat 引导完成", steps };
    } catch (e) {
      push("error", false, String(e.message ?? e));
      return { ok: false, message: String(e.message ?? e), steps };
    }
  }

  return { detect, bootstrap, serviceState };
}