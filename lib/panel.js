/**
 * dsh-qq-remote — QQ 图形开关面板：状态 / 重新登录 / 二维码自动获取 / 白名单。
 * 工厂函数 createPanel(state)。
 * 二维码获取三层：NapCat WebUI API（自动读 webui.json）→ 文件探测 → systemd NAPCAT_WORKDIR 反推。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qrToPng } from "./qrgen.js";
import { runProcess } from "./util.js";

export function createPanel(state) {
  const { ctx, config, log } = state;

  /** NapCat config 目录候选（webui.json 所在处；由 writePath 推导）。 */
  const WEBUI_JSON_CANDIDATES = () => {
    const home = os.homedir();
    const writePaths = [
      path.join(home, "qqnt", "resources", "app", "napcat"),
      path.join(home, "QQ", "resources", "app", "napcat"),
      path.join(home, "NapCat.Shell"),
      "/opt/NapCat.Shell",
      path.join(home, "napcat"),
      "/opt/napcat",
      path.join(home, ".config", "QQ", "NapCat"),
      path.join(home, "Library", "Application Support", "QQ", "NapCat"),
    ];
    return writePaths.map((d) => path.join(d, "config", "webui.json"));
  };

  /** 从 systemd 服务 Environment 读取 NAPCAT_WORKDIR（NapCat 自定义数据目录）。 */
  async function workdirFromSystemd() {
    try {
      const svc = config.napcatServiceName || "napcat-qq";
      const r = await runProcess("systemctl", ["--user", "show", svc, "-p", "Environment"], { timeout: 5000 });
      const m = String(r.out ?? "").match(/NAPCAT_WORKDIR=([^\s]+)/);
      if (m && m[1]) return m[1];
    } catch {}
    return null;
  }

  /** 登录二维码候选路径（自动探测常见 NapCat 安装位置；可用 qrcodePath 配置覆盖）。 */
  const QR_CANDIDATES = () => {
    const home = os.homedir();
    const list = [
      path.join(home, "napcat", "cache", "qrcode.png"),
      path.join(home, "NapCat", "cache", "qrcode.png"),
      path.join(home, "NapCat.Shell", "cache", "qrcode.png"),
      "/opt/NapCat.Shell/cache/qrcode.png",
      "/opt/napcat/cache/qrcode.png",
      path.join(home, "qqnt", "resources", "app", "napcat", "cache", "qrcode.png"),
      path.join(home, "QQ", "resources", "app", "napcat", "cache", "qrcode.png"),
      path.join(home, ".local", "share", "napcat", "cache", "qrcode.png"),
      "/opt/QQ/resources/app/napcat/cache/qrcode.png",
      "/opt/QQNT/resources/app/napcat/cache/qrcode.png",
      path.join(home, ".config", "QQ", "NapCat", "cache", "qrcode.png"),
      path.join(home, ".config", "QQ", "NapCat", "data", "cache", "qrcode.png"),
      path.join(home, "Library", "Application Support", "QQ", "NapCat", "cache", "qrcode.png"),
    ];
    // 由 webui.json 的 config 位置反推 writePath/cache/qrcode.png
    for (const w of WEBUI_JSON_CANDIDATES()) {
      list.push(path.join(path.dirname(path.dirname(w)), "cache", "qrcode.png"));
    }
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

  /** NapCat WebUI 配置（port/token/prefix）：优先用户配置，其次自动探测 webui.json。 */
  function findWebuiConfig() {
    const port = config.webuiPort || 6099;
    if (config.webuiToken) return { port, token: config.webuiToken, prefix: "" };
    for (const p of WEBUI_JSON_CANDIDATES()) {
      try {
        if (!fs.existsSync(p)) continue;
        const d = JSON.parse(fs.readFileSync(p, "utf8"));
        if (d && d.token) return { port: d.port || port, token: d.token, prefix: "" };
      } catch {}
    }
    return null;
  }

  /** NapCat WebUI 登录凭据（1 小时有效，缓存 50 分钟；NapCat 重启后自动重登）。 */
  let webuiCredentialCache = null;
  async function webuiCredential() {
    const wc = findWebuiConfig();
    if (!wc || !wc.token) return null;
    if (webuiCredentialCache && Date.now() - webuiCredentialCache.at < 50 * 60 * 1000) {
      return webuiCredentialCache;
    }
    try {
      const crypto = await import("node:crypto");
      const hash = crypto.createHash("sha256").update(wc.token + ".napcat").digest().toString("hex");
      const r = await fetch(`http://127.0.0.1:${wc.port}${wc.prefix ? "/" + wc.prefix : ""}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => null);
      if (j && j.code === 0 && j.data && typeof j.data.Credential === "string") {
        webuiCredentialCache = { at: Date.now(), cred: j.data.Credential, port: wc.port, prefix: wc.prefix };
        return webuiCredentialCache;
      }
    } catch {}
    return null;
  }

  /** 通过 NapCat WebUI API 主动获取二维码 PNG（不依赖文件路径，Docker/自定义目录均可用）。 */
  async function fetchQrcodeViaWebui() {
    const wc = findWebuiConfig();
    if (!wc || !wc.token) return null;
    const cred = await webuiCredential();
    if (!cred) return null;
    const base = `http://127.0.0.1:${cred.port}${cred.prefix ? "/" + cred.prefix : ""}/api/QQLogin`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cred.cred}` };
    const getUrl = async () => {
      try {
        const r = await fetch(base + "/GetQQLoginQrcode", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null);
        if (j && j.code === 0 && j.data && typeof j.data.qrcode === "string" && j.data.qrcode) return j.data.qrcode;
        if (j && j.code !== 0 && /Unauthorized/i.test(String(j.message ?? ""))) webuiCredentialCache = null; // 凭据过期（NapCat 重启）
      } catch {}
      return null;
    };
    let url = await getUrl();
    if (!url) {
      // 二维码过期/未生成：先刷新再取一次
      try { await fetch(base + "/RefreshQRcode", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(5000) }); } catch {}
      url = await getUrl();
    }
    if (!url) return null;
    try {
      // 老格式端点（ssl.ptlogin2.qq.com/ptqrshow）直接返回 PNG 图片
      const img = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*;q=0.8" }, signal: AbortSignal.timeout(10000) });
      if (img.ok) {
        const ct = String(img.headers.get("content-type") || "");
        const buf = Buffer.from(await img.arrayBuffer());
        if (/^image\//.test(ct) && buf.length > 16) return buf;
      }
    } catch {}
    // 新格式（txz.qq.com/p 等）：内容是链接，本地生成二维码 PNG（零依赖）
    return qrToPng(url, { scale: 4, margin: 4 });
  }

  /** 二维码获取总入口：WebUI API 优先 → 文件探测回退。返回 PNG buffer 或 null。 */
  async function fetchQrcode() {
    // 已登录无需二维码（避免无谓的 WebUI 探测与登录限流）
    if (await state.bot.qqLoggedIn().catch(() => false)) return null;
    const buf = await fetchQrcodeViaWebui();
    if (buf) return buf;
    const p = findQrcode();
    if (p) {
      try {
        return fs.readFileSync(p);
      } catch {}
    }
    // systemd 服务自定义 NAPCAT_WORKDIR 的最后一次机会
    const wd = await workdirFromSystemd();
    if (wd) {
      const p2 = path.join(wd, "cache", "qrcode.png");
      try {
        if (fs.existsSync(p2) && Date.now() - fs.statSync(p2).mtimeMs < 10 * 60 * 1000) return fs.readFileSync(p2);
      } catch {}
    }
    return null;
  }

  /** 读取白名单（配置 overlay 的 allowedUsers）。 */
  function readWhitelist() {
    try {
      const p = path.join(os.homedir(), ".dsh", "qq-remote.json");
      if (!fs.existsSync(p)) return config.allowedUsers ?? [];
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      return Array.isArray(d.allowedUsers) ? d.allowedUsers : (config.allowedUsers ?? []);
    } catch {
      return config.allowedUsers ?? [];
    }
  }

  /** 写入白名单（merge 进 overlay，保留其他字段），并热更新内存 config。 */
  function writeWhitelist(list) {
    const clean = [...new Set(list.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
    const p = path.join(os.homedir(), ".dsh", "qq-remote.json");
    try {
      const d = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
      d.allowedUsers = clean;
      fs.writeFileSync(p, JSON.stringify(d, null, 2));
    } catch (e) {
      log.warn(`[qq-remote] 白名单写入失败: ${e.message}`);
    }
    config.allowedUsers = clean;
    return clean;
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
  }catch(e){log('服务未就绪，自动重试中…');}
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

  /** 注册面板路由（webServer 未就绪时延迟重试 + 防重复注册）。 */
  function registerQqPanel() {
    const webServer = ctx.get("webServer");
    if (!webServer) {
      // 防御：webServer 服务未就绪时延迟重试，避免静默丢失路由
      log.warn("[qq-remote] webServer 未就绪，1s 后重试注册面板路由…");
      setTimeout(() => {
        if (state.disposed) return;
        registerQqPanel();
      }, 1000);
      return;
    }
    if (state.panelRegistered) return; // 已注册过（重试路径）
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
          state.bot.qqLoggedIn().catch(() => false),
          fetchQrcode().catch(() => null),
        ]);
        json(res, {
          loggedIn,
          wsConnected: Boolean(state.ws && state.ws.readyState === WebSocket.OPEN),
          qrAvailable: Boolean(qr),
          qrReason: qr ? "" : "waiting",
        });
      },
    }), "qq-remote: status");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/relogin",
      handler: async (_req, res) => {
        json(res, { ok: true });
        // 后台重启 NapCat：登录态有效则快速登录自动恢复，失效则自动进入二维码模式
        const svc = config.napcatServiceName || "napcat-qq";
        runProcess("systemctl", ["--user", "restart", svc], { timeout: 15000 }).catch(() => {});
      },
    }), "qq-remote: relogin");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/qrcode",
      handler: async (_req, res) => {
        const buf = await fetchQrcode().catch(() => null);
        if (!buf) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("no qrcode yet");
          return;
        }
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(buf);
      },
    }), "qq-remote: qrcode");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/whitelist",
      handler: async (req, res) => {
        if (req.method === "GET") {
          json(res, { allowedUsers: readWhitelist() });
          return;
        }
        if (req.method === "POST") {
          let body = "";
          for await (const chunk of req) body += chunk;
          try {
            const parsed = JSON.parse(body || "{}");
            const list = Array.isArray(parsed.allowedUsers) ? parsed.allowedUsers : [];
            const clean = writeWhitelist(list);
            json(res, { ok: true, allowedUsers: clean });
          } catch (e) {
            json(res, { ok: false, error: String(e.message ?? e) });
          }
          return;
        }
        json(res, { ok: false, error: "method not allowed" });
      },
    }), "qq-remote: whitelist");
    state.panelRegistered = true;
  }

  return { registerQqPanel };
}
