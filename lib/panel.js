/**
 * dsh-qq-remote — QQ 图形开关面板：状态 / 重新登录 / 二维码自动获取 / 白名单 / NapCat 引导。
 * 工厂函数 createPanel(state)。
 * 二维码获取：WebUI API（自动读 webui.json，带缓存与失败退避）→ 文件探测 → systemd/NAPCAT_WORKDIR//proc 反推。
 * 诊断：qrReason 区分 napcat_not_running / webui_not_found / stale_qrcode / waiting。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qrToPng } from "./qrgen.js";
import { runProcess } from "./util.js";
import { createNapcat, SVC_NAME } from "./napcat.js";

/** QR 诊断分类（纯函数，便于测试）。
 *  serviceActive：NapCat 服务**正在运行**（unit active）。
 *  serviceExists：systemd 中存在 napcat 相关 unit（可能未运行）。
 *  "未运行" = unit 不存在或 inactive —— 都归 napcat_not_running（引导按钮显示）。 */
export function classifyQrReason({ ok, loggedIn, serviceActive, webuiAvailable, qrFileExists, qrFileFresh }) {
  if (loggedIn) return "";
  // 服务未运行优先于一切（停止时的二维码残留是死码，扫码无效）
  if (serviceActive === false) return "napcat_not_running";
  if (ok) return "";
  if (qrFileExists && !qrFileFresh) return "stale_qrcode";
  if (!webuiAvailable) return "webui_not_found";
  return "waiting";
}

/** 二维码文件是否新鲜（10 分钟内）。 */
function qrFresh(p) {
  try {
    return Date.now() - fs.statSync(p).mtimeMs < 10 * 60 * 1000;
  } catch {
    return false;
  }
}

export function createPanel(state) {
  const { ctx, config, log } = state;
  /** NapCat 引导模块（检测/安装/配置/服务）。进度回调实时同步到 state.napcatProgress。 */
  const napcat = createNapcat(state, {
    onProgress: (steps) => {
      if (state.napcatProgress) state.napcatProgress.steps = steps.map((s) => ({ ...s }));
    },
  });
  state.napcat = napcat;

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
      path.join(home, ".config", "napcat"),
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

  /** Linux /proc 反推：napcat 进程的 cwd / environ 里的 NAPCAT_WORKDIR。 */
  function workdirFromProc() {
    if (process.platform !== "linux") return null;
    try {
      for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        let cmdline = "";
        try {
          cmdline = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
        } catch {
          continue;
        }
        if (!cmdline.toLowerCase().includes("napcat")) continue;
        let env = "";
        try {
          env = fs.readFileSync(`/proc/${name}/environ`, "utf8");
        } catch {}
        const m = env.match(/NAPCAT_WORKDIR=([^\0]+)/);
        if (m && m[1]) return m[1];
        try {
          return fs.readlinkSync(`/proc/${name}/cwd`);
        } catch {}
      }
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
      path.join(home, ".config", "napcat", "cache", "qrcode.png"),
      path.join(home, "Library", "Application Support", "QQ", "NapCat", "cache", "qrcode.png"),
    ];
    // 由 webui.json 的 config 位置反推 writePath/cache/qrcode.png
    for (const w of WEBUI_JSON_CANDIDATES()) {
      list.push(path.join(path.dirname(path.dirname(w)), "cache", "qrcode.png"));
    }
    if (config.qrcodePath) list.unshift(config.qrcodePath);
    return list;
  };

  /** 返回新鲜的二维码文件路径（过期文件不算）。 */
  function findQrcode() {
    for (const p of QR_CANDIDATES()) {
      try {
        if (fs.existsSync(p) && qrFresh(p)) return p;
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

  /** 查找 NapCat systemd 用户服务：配置值 → 插件托管服务 → 扫描含 napcat 的 unit。
   *  返回 { name, active }；无则 null。active = 正在运行（is-active）。 */
  let svcCache = null;
  let svcCacheAt = 0;
  async function findNapcatServiceName() {
    if (svcCache && Date.now() - svcCacheAt < 30000) return svcCache;
    const preferred = config.napcatServiceName || "napcat-qq";
    for (const cand of [preferred, SVC_NAME]) {
      try {
        const r = await runProcess("systemctl", ["--user", "is-active", cand], { timeout: 5000 });
        const out = String(r.out ?? "").trim();
        if (out === "active") {
          svcCache = { name: cand, active: true };
          svcCacheAt = Date.now();
          return svcCache;
        }
        if (out === "inactive" || out === "failed") {
          // unit 存在但未运行：记录为 inactive，继续找有没有 active 的
          svcCache = { name: cand, active: false };
          svcCacheAt = Date.now();
          return svcCache;
        }
      } catch {}
    }
    try {
      const r = await runProcess("systemctl", ["--user", "list-unit-files", "--no-legend", "--no-pager"], { timeout: 8000 });
      const m = String(r.out ?? "").match(/^(\S*napcat\S*\.service)\s/m);
      if (m && m[1]) {
        svcCache = { name: m[1], active: false };
        svcCacheAt = Date.now();
        return svcCache;
      }
    } catch {}
    svcCache = null;
    svcCacheAt = Date.now();
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

  /** 二维码获取总入口：带 5s 结果缓存 + WebUI 失败 10s 退避（避免轮询触发登录限流）。 */
  let qrFetchCache = null; // { at, buf }
  let webuiFailUntil = 0;
  async function fetchQrcode() {
    if (qrFetchCache && Date.now() - qrFetchCache.at < 5000) return qrFetchCache.buf;
    // 已登录无需二维码
    if (await state.bot.qqLoggedIn().catch(() => false)) {
      qrFetchCache = { at: Date.now(), buf: null };
      return null;
    }
    let buf = null;
    if (Date.now() >= webuiFailUntil) {
      buf = await fetchQrcodeViaWebui();
      if (!buf) webuiFailUntil = Date.now() + 10000; // 失败退避
    }
    const p = findQrcode();
    if (!buf && p) {
      try {
        buf = fs.readFileSync(p);
      } catch {}
    }
    if (!buf) {
      // systemd NAPCAT_WORKDIR / /proc 反推的最后机会
      const wd = (await workdirFromSystemd().catch(() => null)) ?? workdirFromProc();
      if (wd) {
        const p2 = path.join(wd, "cache", "qrcode.png");
        try {
          if (fs.existsSync(p2) && qrFresh(p2)) buf = fs.readFileSync(p2);
        } catch {}
      }
    }
    qrFetchCache = { at: Date.now(), buf };
    return buf;
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
  .card{background:#171e2e;border:1px solid #26304a;border-radius:16px;padding:32px 36px;width:min(440px,92vw);box-shadow:0 12px 40px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
  .sub{color:#8b93a7;font-size:13px;margin-bottom:20px}
  .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #222c44;font-size:14px}
  .row:last-of-type{border-bottom:none}
  .badge{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .ok{background:#12331f;color:#4ade80}.bad{background:#3a1620;color:#f87171}.wait{background:#332b12;color:#facc15}
  button{width:100%;margin-top:18px;padding:12px;border:none;border-radius:10px;background:#4d6bfe;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#5b77ff}button:disabled{background:#2a3350;color:#6b7280;cursor:not-allowed}
  button.danger{background:#b91c1c}button.danger:hover{background:#dc2626}
  button.green{background:#15803d}button.green:hover{background:#16a34a}
  #qrwrap{display:none;margin-top:18px;text-align:center}
  #qrwrap img{width:240px;height:240px;border-radius:12px;background:#fff;padding:10px}
  #qrhint{color:#8b93a7;font-size:12px;margin-top:8px;white-space:pre-line}
  #log{color:#64748b;font-size:12px;margin-top:14px;min-height:16px;white-space:pre-line}
  #bootstrap{margin-top:16px;border-top:1px solid #222c44;padding-top:14px;display:none}
  #bsteps{font-size:12px;color:#8b93a7;margin-top:10px;white-space:pre-line}
</style></head><body>
<div class="card">
  <h1>🤖 QQ 远程控制</h1>
  <div class="sub">dsh-qq-remote 控制面板</div>
  <div class="row"><span>插件连接</span><span id="st-ws" class="badge wait">检测中…</span></div>
  <div class="row"><span>QQ 登录状态</span><span id="st-qq" class="badge wait">检测中…</span></div>
  <button id="btn" disabled>检测中…</button>
  <div id="qrwrap"><img id="qr" alt="登录二维码"><div id="qrhint"></div></div>
  <div id="bootstrap">
    <div class="sub" style="margin-bottom:8px">🧩 NapCat 引导（开箱即用）</div>
    <button id="btn-bs" class="green">一键安装/启动 NapCat</button>
    <div id="bsteps"></div>
  </div>
  <div id="log"></div>
</div>
<script>
const $=id=>document.getElementById(id);
let polling=false, qrTimer=null;
const REASON={napcat_not_running:'⚠️ NapCat 未启动——点下方「一键安装/启动 NapCat」，或先启动你的 NapCat 服务',webui_not_found:'⚠️ 未找到 NapCat WebUI 配置或二维码文件（可在 ~/.dsh/qq-remote.json 设置 qrcodePath）',stale_qrcode:'⚠️ 二维码已过期，NapCat 正在重新生成…',waiting:'⏳ 等待二维码生成…（插件自动从 NapCat WebUI 获取，约 30-60 秒）'};
async function refresh(){
  try{
    const r=await fetch('/qq-remote/status');const s=await r.json();
    $('st-ws').textContent=s.wsConnected?'已连接':'未连接';
    $('st-ws').className='badge '+(s.wsConnected?'ok':'bad');
    $('st-qq').textContent=s.loggedIn?'已登录':'未登录';
    $('st-qq').className='badge '+(s.loggedIn?'ok':'bad');
    const b=$('btn');
    b.disabled=false;b.className='';
    if(s.loggedIn){b.textContent='✅ QQ 已登录（需要重登点这里）';}
    else if(s.qrAvailable){b.textContent='🔄 重新登录（二维码已就绪）';b.className='danger';}
    else{b.textContent='🔄 重新登录（弹出二维码）';b.className='danger';}
    // NapCat 引导区：仅未登录时显示
    const bs=$('bootstrap');
    if(!s.loggedIn&&s.qrReason==='napcat_not_running'){bs.style.display='block';}
    else{bs.style.display='none';}
    $('qrhint').textContent=(!s.loggedIn&&s.qrReason&&REASON[s.qrReason])?REASON[s.qrReason]:'手机 QQ 扫码授权（二维码约 2 分钟有效，过期自动刷新）';
    if(polling&&s.qrAvailable)showQr();
    if(polling&&s.loggedIn){stopPoll();log('✅ 登录成功');}
    if(!s.loggedIn&&s.qrAvailable)showQr();
  }catch(e){log('服务未就绪，自动重试中…');}
}
function showQr(){
  $('qrwrap').style.display='block';
  $('qr').src='/qq-remote/qrcode?t='+Date.now();
}
function stopPoll(){polling=false;clearInterval(qrTimer);}
$('btn').onclick=async()=>{
  const b=$('btn');b.disabled=true;b.textContent='正在重启 NapCat…';
  log('触发重新登录…');
  try{const r=await fetch('/qq-remote/relogin',{method:'POST'});const j=await r.json();
    if(j&&j.ok===false){log('⚠️ '+j.message);b.disabled=false;b.textContent='🔄 重新登录';return;}}
  catch(e){}
  log('等待二维码/自动登录…（NapCat 重启中，约 30-60 秒）');
  $('qrwrap').style.display='none';
  polling=true;qrTimer=setInterval(refresh,3000);
};
$('btn-bs').onclick=async()=>{
  const b=$('btn-bs');b.disabled=true;b.textContent='正在引导 NapCat（下载约 30MB，首次需几分钟）…';
  $('bsteps').textContent='';
  try{await fetch('/qq-remote/napcat/bootstrap',{method:'POST'});}catch(e){}
  const t=setInterval(async()=>{
    try{
      const r=await fetch('/qq-remote/napcat/progress');const j=await r.json();
      if(j.running){$('bsteps').textContent=(j.steps||[]).map(s=>(s.ok?'✅':'⏳')+' '+s.step+' — '+s.message).join('\n');return;}
      clearInterval(t);
      $('bsteps').textContent=(j.steps||[]).map(s=>(s.ok?'✅':'❌')+' '+s.step+' — '+s.message).join('\n');
      b.disabled=false;
      if(j.ok){b.textContent='✅ NapCat 已启动，等待二维码…';refresh();}
      else{b.textContent='一键安装/启动 NapCat';}
    }catch(e){clearInterval(t);b.disabled=false;b.textContent='一键安装/启动 NapCat';}
  },1500);
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
        const [loggedIn, qrBuf] = await Promise.all([
          state.bot.qqLoggedIn().catch(() => false),
          fetchQrcode().catch(() => null),
        ]);
        const svc = await findNapcatServiceName();
        const qrPath = findQrcode();
        const webui = findWebuiConfig();
        const reason = classifyQrReason({
          ok: Boolean(qrBuf),
          loggedIn,
          serviceActive: svc ? svc.active : false,
          webuiAvailable: webui != null,
          qrFileExists: qrPath != null,
          qrFileFresh: qrPath ? qrFresh(qrPath) : false,
        });
        json(res, {
          loggedIn,
          wsConnected: Boolean(state.ws && state.ws.readyState === WebSocket.OPEN),
          qrAvailable: Boolean(qrBuf),
          qrReason: reason,
          napcatService: svc ? svc.name : null,
          napcatActive: svc ? svc.active : false,
        });
      },
    }), "qq-remote: status");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/relogin",
      handler: async (_req, res) => {
        // 先确认 NapCat 服务存在，不存在则返回真实失败原因（不假装成功）
        const svc = await findNapcatServiceName();
        if (!svc || !svc.active) {
          json(res, {
            ok: false,
            message: `NapCat 未在运行（${svc ? svc.name + " 未启动" : "未找到 systemd 服务"}）。请先启动 NapCat，或点面板「一键安装/启动 NapCat」，或在 ~/.dsh/qq-remote.json 配置 napcatServiceName / qrcodePath。`,
          });
          return;
        }
        json(res, { ok: true, message: `正在重启 ${svc.name}…` });
        // 后台重启 NapCat：登录态有效则快速登录自动恢复，失效则自动进入二维码模式
        runProcess("systemctl", ["--user", "restart", svc.name], { timeout: 15000 }).catch(() => {});
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
    // ── NapCat 引导（开箱即用） ────────────────────────────────
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/napcat",
      handler: async (_req, res) => {
        const detected = await napcat.detect().catch(() => null);
        json(res, { detected, qrReason: "napcat_not_running" });
      },
    }), "qq-remote: napcat");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/napcat/bootstrap",
      handler: async (_req, res) => {
        if (state.napcatBusy) {
          json(res, { ok: false, message: "引导已在运行中" });
          return;
        }
        // 防双实例顶号：OneBot 已连接说明已有 NapCat 在运行
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          json(res, { ok: false, message: "OneBot 已连接（已有 NapCat 在运行），无需引导" });
          return;
        }
        state.napcatBusy = true;
        state.napcatProgress = { running: true, steps: [], ok: false };
        json(res, { ok: true, message: "引导已开始" });
        const result = await napcat.bootstrap().catch((e) => ({ ok: false, message: String(e.message ?? e), steps: [] }));
        state.napcatProgress = { running: false, ...result };
        state.napcatBusy = false;
      },
    }), "qq-remote: napcat/bootstrap");
    ctx.effect(() => webServer.register({
      kind: "exact", path: "/qq-remote/napcat/progress",
      handler: async (_req, res) => {
        json(res, state.napcatProgress ?? { running: false, steps: [], ok: false });
      },
    }), "qq-remote: napcat/progress");
    state.panelRegistered = true;
  }

  return { registerQqPanel };
}
