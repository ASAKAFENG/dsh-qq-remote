/**
 * dsh-qq-remote — 纯净聊天模式：持久化 + 多聊天会话 + 聊天特化绑定。
 * 工厂函数 createChat(state)。state: { ctx, config, log, chats, chatMode, chatName, bot }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHAT_DIR = path.join(os.homedir(), ".dsh", "qq-remote-chats");
const CHAT_NAME_RE = /^[\w\u4e00-\u9fa5-]{1,32}$/;

export function createChat(state) {
  const { ctx, config, log } = state;

  function chatPath(name) {
    return path.join(CHAT_DIR, name + ".json");
  }

  /** 加载（或新建）一个聊天会话的记忆。 */
  function loadChat(name) {
    if (state.chats.has(name)) return state.chats.get(name);
    let arr = [];
    try {
      const p = chatPath(name);
      if (fs.existsSync(p)) arr = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      log.warn(`[qq-remote] 读取聊天记忆失败(${name}): ${e.message}`);
    }
    if (!Array.isArray(arr)) arr = [];
    state.chats.set(name, arr);
    return arr;
  }

  /** 保存一个聊天会话的记忆到磁盘。 */
  function saveChat(name) {
    try {
      fs.mkdirSync(CHAT_DIR, { recursive: true });
      fs.writeFileSync(chatPath(name), JSON.stringify(state.chats.get(name) ?? []));
    } catch (e) {
      log.warn(`[qq-remote] 保存聊天记忆失败(${name}): ${e.message}`);
    }
  }

  /** 列出磁盘上的所有聊天会话。 */
  function listChatNames() {
    try {
      if (!fs.existsSync(CHAT_DIR)) return [];
      return fs.readdirSync(CHAT_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  /** 当前目标会话是否"聊天特化"（私聊消息直接聊天回复，不走任务）。 */
  function isChatTarget() {
    if (!config.targetSessionId) return false;
    const agents = ctx.get("agents");
    const a = agents?.get(config.targetSessionId);
    if (!a) return false;
    const title = sessionTitleOf(a.session) ?? config.targetSessionId;
    return config.chatSessionNames.includes(title) || config.chatSessionNames.includes(config.targetSessionId);
  }

  /** 聊天记忆的会话名：聊天特化会话用其标题/id，否则用当前 /chat 会话。 */
  function chatNameFor() {
    if (config.targetSessionId) {
      const agents = ctx.get("agents");
      const a = agents?.get(config.targetSessionId);
      if (a) return sessionTitleOf(a.session) ?? config.targetSessionId;
    }
    return state.chatName;
  }

  /** 读取会话标题（无标题返回 undefined）。get() 返回 {title,...} 对象或字符串。 */
  function sessionTitleOf(session) {
    try {
      const t = ctx.get("sessionTitle")?.get(session);
      if (t === undefined || t === null) return undefined;
      return typeof t === "string" ? t : t.title;
    } catch {
      return undefined;
    }
  }

  /** 把聊天特化名单持久化到 ~/.dsh/qq-remote.json（重启后保留）。 */
  function persistChatSessionNames() {
    try {
      const p = path.join(os.homedir(), ".dsh", "qq-remote.json");
      const overlay = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
      overlay.chatSessionNames = config.chatSessionNames;
      fs.writeFileSync(p, JSON.stringify(overlay, null, 2));
    } catch (e) {
      log.warn(`[qq-remote] 持久化聊天特化名单失败: ${e.message}`);
    }
  }

  /** 绑定/解绑当前目标会话为聊天特化。 */
  async function doChatBind(arg) {
    const agents = ctx.get("agents");
    const a = config.targetSessionId ? agents?.get(config.targetSessionId) : null;
    if (!a) {
      await state.bot.reply("❌ 请先设置目标会话（/session <序号|标题|id>）再绑定");
      return;
    }
    const title = sessionTitleOf(a.session) ?? config.targetSessionId;
    const on = arg !== "off" && arg !== "0";
    if (on) {
      if (!config.chatSessionNames.includes(title)) config.chatSessionNames.push(title);
      persistChatSessionNames();
      await state.bot.reply(`💗 会话「${title}」已绑定为聊天特化\n发消息 = 直接聊天回复（像真人 QQ，不走任务/不推进度）\n/chatbind off 可解除`);
    } else {
      config.chatSessionNames = config.chatSessionNames.filter((n) => n !== title && n !== config.targetSessionId);
      persistChatSessionNames();
      await state.bot.reply(`🔧 会话「${title}」已解除聊天特化，恢复任务模式`);
    }
  }

  /** 纯净聊天模式开关。 */
  async function doChatMode(arg) {
    if (arg === "on" || arg === "1") {
      loadChat(state.chatName);
      state.chatMode = true;
      await state.bot.reply(`💬 纯净聊天模式已开启（会话「${state.chatName}」）！直接发消息聊天（/chat off 退出，/chat <名字> 切换会话）`);
    } else if (arg === "off" || arg === "0") {
      saveChat(state.chatName);
      state.chatMode = false;
      await state.bot.reply("✅ 纯净聊天模式已关闭，恢复任务/命令模式");
    } else if (arg === "clear") {
      state.chats.set(state.chatName, []);
      saveChat(state.chatName);
      await state.bot.reply(`🧹 聊天会话「${state.chatName}」的记忆已清空`);
    } else if (arg === "list") {
      const names = listChatNames();
      await state.bot.reply(`📚 聊天会话${names.length ? ":\n" + names.map((n) => `• ${n}${n === state.chatName ? "（当前）" : ""}`).join("\n") : ":（暂无）"}`);
    } else if (arg) {
      if (!CHAT_NAME_RE.test(arg)) {
        await state.bot.reply("⚠️ 会话名只能含中文/字母/数字/横线，且不超过 32 字");
        return;
      }
      saveChat(state.chatName); // 保存当前会话
      state.chatName = arg;
      loadChat(state.chatName);
      state.chatMode = true;
      const count = state.chats.get(state.chatName).length;
      await state.bot.reply(`💬 已切换到聊天会话「${arg}」${count > 0 ? `（记忆 ${count} 条）` : "（新会话）"}，直接发消息聊天吧`);
    } else {
      const count = loadChat(state.chatName).length;
      await state.bot.reply(`💬 纯净聊天模式: ${state.chatMode ? "开 ✅" : "关"}｜当前会话「${state.chatName}」（记忆 ${count} 条）\n/chat on 开启 / /chat <名字> 切换 / /chat list 列表 / /chat clear 清空 / /chat off 退出`);
    }
  }

  /** 纯净聊天：直接调 LLM 像人一样回复（不走任务/工具/进度推送）。 */
  async function chatReply(text) {
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (!selection?.provider || !selection?.model) {
      await state.bot.reply("❌ 无法获取默认模型（请先在 DSH 配置模型）");
      return;
    }
    const name = chatNameFor();
    const history = loadChat(name);
    // 消息必须带 source（dsh-llm 的 forAdapter 会访问 assistant 消息的 source.kind）
    history.push({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
    // 上下文：默认全量（chatHistoryLimit/chatMaxChars 为 0 时不截断）
    let send = history;
    if (config.chatHistoryLimit > 0) send = history.slice(-config.chatHistoryLimit);
    if (config.chatMaxChars > 0) {
      let budget = 0;
      for (let i = send.length - 1; i >= 0; i--) {
        budget += (send[i].content?.[0]?.text ?? "").length;
        if (budget > config.chatMaxChars) {
          send = send.slice(i + 1);
          break;
        }
      }
    }
    const messages = [
      { role: "system", source: { kind: "system" }, content: [{ type: "text", text: config.chatSystemPrompt }] },
      ...send,
    ];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90000);
    let out = "";
    try {
      const stream = ctx.get("llm").stream({
        provider: selection.provider,
        model: selection.model,
        messages,
        signal: ac.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === "text-delta") out += chunk.text;
        else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
          throw new Error(chunk.reason.failure?.message ?? "模型调用失败");
        }
      }
    } catch (e) {
      clearTimeout(timer);
      history.pop(); // 回滚失败的用户消息
      const hint = /context|窗口|token/i.test(e.message) ? "\n💡 可能上下文太长：/chat clear 清空记忆，或在配置里设 chatHistoryLimit/chatMaxChars" : "";
      await state.bot.reply(`⚠️ 对话出错: ${e.message}${hint}`);
      return;
    }
    clearTimeout(timer);
    const clean = out.trim();
    history.push({
      role: "assistant",
      source: { kind: "model", provider: selection.provider, model: selection.model },
      content: [{ type: "text", text: clean || "（无回复）" }],
    });
    saveChat(name);
    await state.bot.reply(clean || "（无回复）");
  }

  return {
    chatPath,
    loadChat,
    saveChat,
    listChatNames,
    isChatTarget,
    chatNameFor,
    sessionTitleOf,
    persistChatSessionNames,
    doChatBind,
    doChatMode,
    chatReply,
  };
}
