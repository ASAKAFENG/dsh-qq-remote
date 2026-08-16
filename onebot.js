/**
 * dsh-qq-remote — OneBot 11 连接层（反向 WebSocket + 可选 HTTP API）。
 * 工厂函数 createBot(state)：连接管理 / 看门狗 / API 调用 / 消息发送。
 * state 由 index.js 装配：{ ctx, config, log, controller, ws, wsSeq, reconnectTimer, waiters, disposed, watchdogTimer }
 */
import { truncate } from "./util.js";

export function createBot(state) {
  const { ctx, config, log } = state;

  /** 建立 OneBot 反向 WS 连接（事件 + API 同一条连接）。 */
  function connect() {
    if (state.disposed || !config.wsUrl) return;
    try {
      let url = config.wsUrl;
      if (config.token && !url.includes("access_token")) {
        url += (url.includes("?") ? "&" : "?") + `access_token=${encodeURIComponent(config.token)}`;
      }
      log.info(`[qq-remote] 连接 OneBot: ${url}`);
      state.ws = new WebSocket(url);
      state.ws.onopen = () => {
        log.info("[qq-remote] OneBot 已连接");
      };
      state.ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg && typeof msg === "object") {
          if (msg.echo && state.waiters.has(String(msg.echo))) {
            const w = state.waiters.get(String(msg.echo));
            state.waiters.delete(String(msg.echo));
            clearTimeout(w.timer);
            if (msg.status === "ok" && (msg.retcode === 0 || msg.retcode === undefined)) w.resolve(msg.data);
            else w.reject(new Error(msg.status === "failed" ? `retcode=${msg.retcode}` : `status=${msg.status}`));
            return;
          }
          if (msg.post_type === "message") state.cmds.handleMessageEvent(msg);
        }
      };
      state.ws.onclose = () => {
        log.warn("[qq-remote] OneBot 连接断开，重连中…");
        state.ws = null;
        for (const w of state.waiters.values()) {
          clearTimeout(w.timer);
          w.reject(new Error("连接已断开"));
        }
        state.waiters.clear();
        scheduleReconnect();
      };
      state.ws.onerror = () => {
        try {
          state.ws?.close();
        } catch {}
      };
    } catch (e) {
      log.warn(`[qq-remote] 连接失败: ${e.message}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (state.disposed || state.reconnectTimer || !config.wsUrl) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, config.reconnectDelayMs);
  }

  /** 看门狗：连接不在 OPEN 状态就发起重连（每 10s 检查一次）。 */
  function startWatchdog() {
    if (state.disposed || state.watchdogTimer || !config.wsUrl) return;
    state.watchdogTimer = setInterval(() => {
      if (state.disposed) return;
      const wsState = state.ws?.readyState;
      const connecting = wsState === WebSocket.CONNECTING;
      const alive = wsState === WebSocket.OPEN;
      if (!alive && !connecting && !state.reconnectTimer) scheduleReconnect();
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
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("OneBot 未连接"));
        return;
      }
      const echo = `qqr_${++state.wsSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        state.waiters.delete(echo);
        reject(new Error(`OneBot API 超时: ${action}`));
      }, timeout);
      state.waiters.set(echo, { resolve, reject, timer });
      try {
        state.ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        state.waiters.delete(echo);
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
    if (!state.controller) throw new Error("没有绑定的 QQ 控制端");
    await sendText(state.controller.userId, state.controller.groupId, text);
  }

  /** 是否已登录 QQ（通过 get_login_info 探测）。 */
  async function qqLoggedIn() {
    try {
      const info = await api("get_login_info", {}, 5000);
      return Boolean(info?.user_id);
    } catch {
      return false;
    }
  }

  return { connect, scheduleReconnect, startWatchdog, api, sendText, sendImage, reply, qqLoggedIn };
}
