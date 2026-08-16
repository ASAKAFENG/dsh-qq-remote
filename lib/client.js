/**
 * dsh-qq-remote — browser half.
 *
 * A "QQ 远程" section inside the Web UI settings page: live status
 * (plugin connection / QQ login), a "重新登录" switch that restarts NapCat
 * and pops up the login QR code, plus a link to the full control panel.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-qq-remote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens) ────────────────────────────────────────────────
    var CSS = ".__qr_root{max-width:640px;display:flex;flex-direction:column;gap:12px}" +
      ".__qr_row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__qr_label{font-size:13px;color:var(--dsw-alias-label-primary)}" +
      ".__qr_badge{padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}" +
      ".__qr_ok{background:rgba(74,222,128,.15);color:#4ade80}" +
      ".__qr_bad{background:rgba(248,113,113,.15);color:#f87171}" +
      ".__qr_wait{background:rgba(250,204,21,.15);color:#facc15}" +
      ".__qr_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:10px 16px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}" +
      ".__qr_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__qr_btn:disabled{opacity:.6;cursor:default}" +
      ".__qr_btnDanger{border-color:#b91c1c;background:#b91c1c;color:#fff}" +
      ".__qr_btnDanger:hover:not(:disabled){background:#dc2626}" +
      ".__qr_qr{margin-top:12px;text-align:center;display:none}" +
      ".__qr_qr img{width:220px;height:220px;border-radius:12px;background:#fff;padding:8px}" +
      ".__qr_hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:8px}" +
      ".__qr_msg{font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:16px;margin-top:6px}" +
      ".__qr_group{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px;margin:10px 0 2px}" +
      ".__qr_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__qr_link{font-size:12px;color:var(--dsw-alias-state-business-primary);text-decoration:none}" +
      ".__qr_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}";
    var tagId = "dsh-qq-remote/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-qq-remote";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "qqRemote";
    var inject = ["slots", "locale"];
    var zh = {
      nav: "QQ 远程",
      intro: "QQ 远程控制状态与登录开关（由 dsh-qq-remote 提供）",
      ws: "插件连接",
      qq: "QQ 登录",
      connected: "已连接",
      disconnected: "未连接",
      loggedIn: "已登录",
      loggedOut: "未登录",
      checking: "检测中…",
      relogin: "🔄 重新登录（弹出二维码）",
      reloginQr: "🔄 重新登录（二维码已就绪）",
      reloginOk: "✅ QQ 已登录",
      busy: "正在重启 NapCat…",
      waiting: "等待二维码/自动登录（约 30-60 秒）…",
      qrHint: "手机 QQ 扫码授权（约 2 分钟有效，过期自动刷新）",
      panel: "打开完整控制面板 →",
      failed: "状态获取失败",
      unavailable: "服务端未注册 dsh-qq-remote？",
      done: "✅ 登录成功",
      wlTitle: "控制白名单",
      wlHint: "允许通过 QQ 控制本机的 QQ 号（留空=任何人都能控制，危险）",
      wlAdd: "添加",
      wlRemove: "删除",
      wlSave: "保存白名单",
      wlSaved: "✅ 白名单已保存",
      wlSaveFail: "保存失败",
      wlInputPlaceholder: "输入 QQ 号",
      qrWaiting: "⏳ 等待二维码生成…插件会自动从 NapCat WebUI 与常见安装路径获取（重启后约 30-60 秒）。若持续没有：NapCat 可能已登录，或可在配置里设置 qrcodePath 指定路径",
      rNapcat: "⚠️ NapCat 未启动 —— 点下方「一键安装/启动 NapCat」，或先启动你的 NapCat 服务",
      rWebui: "⚠️ 未找到 NapCat WebUI 配置或二维码文件（可在 ~/.dsh/qq-remote.json 设置 qrcodePath）",
      rStale: "⚠️ 二维码已过期，NapCat 正在重新生成…",
      rWaiting: "⏳ 等待二维码生成…（插件自动从 NapCat WebUI 获取，约 30-60 秒）",
      bsTitle: "🧩 NapCat 引导（开箱即用）",
      bsBtn: "一键安装/启动 NapCat",
      bsBusy: "正在引导 NapCat（下载约 30MB，首次需几分钟）…",
      bsDone: "✅ NapCat 已启动，等待二维码…",
      bsFail: "一键安装/启动 NapCat",
      bsStart: "引导已开始…",
      dlTitle: "⬇️ NapCat 下载源",
      dlHint: "下载约 29MB；国内网络慢可换镜像",
      dlCustom: "自定义地址",
      dlSave: "保存下载源",
      dlSaved: "✅ 下载源已保存"
    };
    var en = {
      nav: "QQ Remote",
      intro: "QQ remote control status & login switch (provided by dsh-qq-remote)",
      ws: "Plugin",
      qq: "QQ Login",
      connected: "Connected",
      disconnected: "Disconnected",
      loggedIn: "Logged in",
      loggedOut: "Logged out",
      checking: "Checking…",
      relogin: "🔄 Re-login (show QR)",
      reloginQr: "🔄 Re-login (QR ready)",
      reloginOk: "✅ QQ logged in",
      busy: "Restarting NapCat…",
      waiting: "Waiting for QR / auto login (~30-60s)…",
      qrHint: "Scan with QQ mobile (valid ~2 min, auto refresh)",
      qrWaiting: "⏳ Waiting for QR... plugin auto-fetches from NapCat WebUI & common install paths (~30-60s after restart). If none: NapCat may be logged in, or set qrcodePath in config",
      panel: "Open full panel →",
      failed: "Status fetch failed",
      unavailable: "dsh-qq-remote not registered server-side?",
      done: "✅ Login success",
      wlTitle: "Control whitelist",
      wlHint: "QQ numbers allowed to control (empty = anyone, dangerous)",
      wlAdd: "Add",
      wlRemove: "Remove",
      wlSave: "Save whitelist",
      wlSaved: "✅ Whitelist saved",
      wlSaveFail: "Save failed",
      wlInputPlaceholder: "Enter QQ number",
      rNapcat: "⚠️ NapCat not running — click 'Install/Start NapCat' below, or start your NapCat service",
      rWebui: "⚠️ NapCat WebUI config / qrcode file not found (set qrcodePath in ~/.dsh/qq-remote.json)",
      rStale: "⚠️ QR code expired, NapCat regenerating…",
      rWaiting: "⏳ Waiting for QR… (auto-fetch from NapCat WebUI, ~30-60s)",
      bsTitle: "🧩 NapCat bootstrap (out-of-box)",
      bsBtn: "Install / Start NapCat",
      bsBusy: "Bootstrapping NapCat (~30MB download on first run)…",
      bsDone: "✅ NapCat started, waiting for QR…",
      bsFail: "Install / Start NapCat",
      bsStart: "Bootstrap started…",
      dlTitle: "⬇️ NapCat download source",
      dlHint: "~29MB download; switch mirror if slow",
      dlCustom: "Custom URL",
      dlSave: "Save source",
      dlSaved: "✅ Source saved"
    };

    // ── Section component ─────────────────────────────────────────────────
    function QqRemoteSection(props) {
      var t = props.t || function (k) { return zh[k] || k; };
      var state = react.useState({ loading: true, loggedIn: false, ws: false, qr: false, busy: false, reason: "", bsBusy: false, bsSteps: [], msg: "", wl: [], wlInput: "", wlMsg: "", mirrors: [], dlId: "official", dlCustom: "" });
      var st = state[0];
      var set = state[1];
      var qrTimer = react.useRef(null);
      var bsTimer = react.useRef(null);
      var polling = react.useRef(false);

      react.useEffect(function () {
        var alive = true;
        var load = async function () {
          try {
            var r = await fetch("/qq-remote/status");
            var s = await r.json();
            if (!alive) return;
            set(function (prev) {
              var next = Object.assign({}, prev, {
                loading: false, loggedIn: !!s.loggedIn, ws: !!s.wsConnected, qr: !!s.qrAvailable, reason: s.qrReason || ""
              });
              if (polling.current && s.qrAvailable) { next.msg = ""; next.busy = false; }
              if (polling.current && s.loggedIn) {
                polling.current = false;
                if (qrTimer.current) { clearInterval(qrTimer.current); qrTimer.current = null; }
                next.msg = t("done");
                next.busy = false;
              }
              return next;
            });
          } catch (e) {
            if (alive) set(function (prev) { return Object.assign({}, prev, { loading: false, loggedIn: false, ws: false, qr: false, msg: t("failed") + "（服务未就绪，自动重试中…）" }); });
          }
        };
        load();
        var loadWl = async function () {
          try {
            var r = await fetch("/qq-remote/whitelist");
            var w = await r.json();
            if (alive && Array.isArray(w.allowedUsers)) set(function (prev) { return Object.assign({}, prev, { wl: w.allowedUsers }); });
          } catch (e) {}
        };
        loadWl();
        var loadDl = async function () {
          try {
            var r = await fetch("/qq-remote/napcat/settings");
            var d = await r.json();
            if (alive && Array.isArray(d.mirrors)) set(function (prev) { return Object.assign({}, prev, { mirrors: d.mirrors, dlId: d.currentId || "custom", dlCustom: d.currentId === "custom" ? d.current : "" }); });
          } catch (e) {}
        };
        loadDl();
        var timer = setInterval(function () { load(); loadWl(); }, 4000);
        return function () { alive = false; clearInterval(timer); if (qrTimer.current) clearInterval(qrTimer.current); if (bsTimer.current) clearInterval(bsTimer.current); };
      }, []);

      var relogin = async function () {
        set(function (prev) { return Object.assign({}, prev, { busy: true, msg: t("waiting") }); });
        try {
          var r = await fetch("/qq-remote/relogin", { method: "POST" });
          var j = await r.json().catch(function () { return null; });
          if (j && j.ok === false) {
            set(function (prev) { return Object.assign({}, prev, { busy: false, msg: "⚠️ " + j.message }); });
            return;
          }
        } catch (e) {}
        polling.current = true;
        qrTimer.current = setInterval(function () {
          // 二维码过期刷新（img 带时间戳由 status 轮询触发）
        }, 3000);
      };

      var reasonText = function () {
        if (!st.reason || st.loggedIn || st.qr) return t("qrWaiting");
        return { napcat_not_running: t("rNapcat"), webui_not_found: t("rWebui"), stale_qrcode: t("rStale") }[st.reason] || t("rWaiting");
      };

      var saveDl = async function () {
        var url = "";
        var sel = (st.mirrors || []).filter(function (m) { return m.id === st.dlId; })[0];
        if (sel && st.dlId !== "custom") url = sel.url;
        else url = st.dlCustom.trim();
        if (!url) return;
        try {
          var r = await fetch("/qq-remote/napcat/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url })
          });
          var j = await r.json();
          set(function (prev) { return Object.assign({}, prev, { msg: j.ok ? t("dlSaved") : ("⚠️ " + (j.error || "")) }); });
        } catch (e) {}
      };

      var startBootstrap = async function () {
        set(function (prev) { return Object.assign({}, prev, { bsBusy: true, bsSteps: [] }); });
        try {
          await fetch("/qq-remote/napcat/bootstrap", { method: "POST" });
        } catch (e) {}
        bsTimer.current = setInterval(async function () {
          try {
            var r = await fetch("/qq-remote/napcat/progress");
            var j = await r.json();
            if (j.running) {
              set(function (prev) { return Object.assign({}, prev, { bsSteps: j.steps || [] }); });
              return;
            }
            if (bsTimer.current) { clearInterval(bsTimer.current); bsTimer.current = null; }
            set(function (prev) {
              return Object.assign({}, prev, { bsBusy: false, bsSteps: j.steps || [], msg: j.ok ? t("bsDone") : (j.message || "") });
            });
          } catch (e) {
            if (bsTimer.current) { clearInterval(bsTimer.current); bsTimer.current = null; }
            set(function (prev) { return Object.assign({}, prev, { bsBusy: false }); });
          }
        }, 1500);
      };

      var badge = function (ok, wait) {
        return h("span", { className: "__qr_badge " + (wait ? "__qr_wait" : (ok ? "__qr_ok" : "__qr_bad")) },
          wait ? t("checking") : (ok ? (ok === "on" ? t("connected") : t("loggedIn")) : (ok === "off" ? t("disconnected") : t("loggedOut"))));
      };

      var btnLabel = st.loading ? t("checking")
        : st.busy ? t("busy")
        : st.loggedIn ? t("reloginOk")
        : st.qr ? t("reloginQr")
        : t("relogin");

      return h("div", { className: "__qr_root" },
        h("div", { className: "__qr_row" },
          h("span", { className: "__qr_label" }, t("ws")),
          st.loading ? h("span", { className: "__qr_badge __qr_wait" }, t("checking"))
            : h("span", { className: "__qr_badge " + (st.ws ? "__qr_ok" : "__qr_bad") }, st.ws ? t("connected") : t("disconnected"))),
        h("div", { className: "__qr_row" },
          h("span", { className: "__qr_label" }, t("qq")),
          st.loading ? h("span", { className: "__qr_badge __qr_wait" }, t("checking"))
            : h("span", { className: "__qr_badge " + (st.loggedIn ? "__qr_ok" : "__qr_bad") }, st.loggedIn ? t("loggedIn") : t("loggedOut"))),
        h("button", {
          className: "__qr_btn" + (st.loggedIn ? "" : " __qr_btnDanger"),
          disabled: st.loading || st.busy,
          onClick: relogin
        }, btnLabel),
        h("div", {
          className: "__qr_qr",
          style: { display: (!st.loggedIn && !st.loading) ? "block" : "none" }
        },
          st.qr
            ? h("img", { src: "/qq-remote/qrcode?t=" + Date.now(), alt: "QR" })
            : h("div", { className: "__qr_hint" }, reasonText()),
          h("div", { className: "__qr_hint" }, t("qrHint"))),
        (!st.loggedIn && st.reason === "napcat_not_running" && !st.loading)
          ? h("div", { className: "__qr_group" }, t("bsTitle")) : null,
        (!st.loggedIn && st.reason === "napcat_not_running" && !st.loading)
          ? h("button", {
            className: "__qr_btn",
            disabled: st.bsBusy,
            onClick: startBootstrap
          }, st.bsBusy ? t("bsBusy") : t("bsBtn")) : null,
        (st.bsSteps && st.bsSteps.length > 0)
          ? h("div", { className: "__qr_hint" }, (st.bsSteps || []).map(function (s) { return (s.ok ? "✅" : "⏳") + " " + s.step + " — " + s.message; }).join("\n")) : null,
        (!st.loggedIn && st.reason === "napcat_not_running" && !st.loading)
          ? h("div", { className: "__qr_group" }, t("dlTitle")) : null,
        (!st.loggedIn && st.reason === "napcat_not_running" && !st.loading)
          ? h("div", { className: "__qr_row" },
            h("select", {
              className: "__qr_input",
              style: { width: "100%" },
              value: st.dlId || "official",
              onChange: function (e) { set(function (prev) { return Object.assign({}, prev, { dlId: e.target.value }); }); }
            },
              (st.mirrors || []).map(function (m) {
                return h("option", { key: m.id, value: m.id }, m.name);
              }),
              h("option", { key: "custom", value: "custom" }, t("dlCustom")))) : null,
        (!st.loggedIn && st.reason === "napcat_not_running" && !st.loading && st.dlId === "custom")
          ? h("div", { className: "__qr_row" },
            h("input", {
              className: "__qr_input",
              placeholder: "https://…/NapCat.Shell.zip",
              value: st.dlCustom,
              onChange: function (e) { set(function (prev) { return Object.assign({}, prev, { dlCustom: e.target.value }); }); }
            })) : null,
        (!st.loggedIn && st.reason === "napcat_not_running" && !st.loading)
          ? h("div", { className: "__qr_row" },
            h("button", { className: "__qr_btn", onClick: saveDl }, t("dlSave")),
            h("span", { className: "__qr_label", style: { fontSize: "12px" } }, t("dlHint"))) : null,
        h("div", { className: "__qr_msg" }, st.msg || t("intro")),
        h("div", { className: "__qr_group" }, t("wlTitle")),
        h("div", { className: "__qr_hint" }, t("wlHint")),
        (st.wl || []).map(function (uin) {
          return h("div", { key: uin, className: "__qr_row" },
            h("span", { className: "__qr_label" }, String(uin)),
            h("button", {
              className: "__qr_btn",
              onClick: function () {
                set(function (prev) {
                  var wl = prev.wl.filter(function (x) { return x !== uin; });
                  return Object.assign({}, prev, { wl: wl });
                });
              }
            }, t("wlRemove")));
        }),
        h("div", { className: "__qr_row" },
          h("input", {
            className: "__qr_input",
            placeholder: t("wlInputPlaceholder"),
            value: st.wlInput,
            onChange: function (e) { set(function (prev) { return Object.assign({}, prev, { wlInput: e.target.value }); }); }
          }),
          h("button", {
            className: "__qr_btn",
            onClick: function () {
              var v = parseInt(st.wlInput.trim(), 10);
              if (!v) return;
              set(function (prev) {
                var wl = prev.wl.indexOf(v) >= 0 ? prev.wl : prev.wl.concat([v]);
                return Object.assign({}, prev, { wl: wl, wlInput: "" });
              });
            }
          }, t("wlAdd"))),
        h("button", {
          className: "__qr_btn",
          onClick: async function () {
            try {
              var r = await fetch("/qq-remote/whitelist", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ allowedUsers: st.wl })
              });
              var j = await r.json();
              set(function (prev) { return Object.assign({}, prev, { wlMsg: j.ok ? t("wlSaved") : t("wlSaveFail") }); });
            } catch (e) {
              set(function (prev) { return Object.assign({}, prev, { wlMsg: t("wlSaveFail") }); });
            }
          }
        }, t("wlSave")),
        h("div", { className: "__qr_msg" }, st.wlMsg || ""),
        h("a", { className: "__qr_link", href: "/qq-remote/panel", target: "_blank" }, t("panel"))
      );
    }

    // ── apply ─────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(function () {
        ctx.locale.register(NS, { zh, en });
      }, "dsh-qq-remote: dictionaries");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "qq-remote",
          order: 98,
          label: function () { return t("nav"); },
          locale: NS
        }, function (sectionProps) {
          return h(QqRemoteSection, {
            t: function (k) { return t(k); }
          });
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
