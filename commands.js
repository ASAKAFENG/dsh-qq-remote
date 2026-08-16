/**
 * dsh-qq-remote — 消息处理 / 命令路由 / Agent 桥接 / 进度推送 / Agent 工具注册。
 * 工厂函数 createCommands(state)。
 * state: { ctx, config, log, controller, bot, chat, lastEventAt, activeTask, pendingReports, pendingTimer, lastReportAt, phaseState, heartbeatTimer, disposed }
 */
import fs from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  truncate,
  extractText,
  extractMediaTypes,
  formatEventLine,
  extractAssistantText,
  takeScreenshot,
  runProcess,
} from "./util.js";

export function createCommands(state) {
  const { ctx, config, log } = state;

  // ── 消息处理 ──────────────────────────────────────────────────
  function authorized(userId) {
    if (!config.allowedUsers || config.allowedUsers.length === 0) {
      log.warn(`[qq-remote] 警告: allowedUsers 未配置白名单，QQ ${userId} 的消息将被接受`);
      return true;
    }
    return config.allowedUsers.includes(userId);
  }

  async function handleMessageEvent(ev) {
    if (ev.message_type !== "private" && ev.message_type !== "group") return;
    const userId = ev.user_id;
    if (!authorized(userId)) return;
    const groupId = ev.group_id;
    let text = extractText(ev.message);
    if (!text) {
      // 纯媒体消息（语音/图片/文件…）：不静默，给友好提示
      const media = extractMediaTypes(ev.message);
      if (media.length > 0 && ev.message_type === "private") {
        state.controller = { userId, groupId, isPrivate: true };
        const hint = media.includes("record")
          ? "🎤 收到语音啦～我暂时听不懂语音，请用文字发给我哦"
          : `📎 收到 ${media.join("/")} 消息，暂不支持处理，请用文字发送～`;
        try {
          await state.bot.reply(hint);
        } catch {}
      }
      return;
    }
    const isPrivate = ev.message_type === "private";
    if (!isPrivate) {
      if (!text.startsWith(config.groupPrefix)) return;
      text = text.slice(config.groupPrefix.length).trim();
    }
    if (!text) return;
    state.controller = { userId, groupId, isPrivate };
    try {
      await routeCommand(text, isPrivate);
    } catch (e) {
      log.warn(`[qq-remote] 命令处理失败: ${e.message}`);
      try {
        await state.bot.reply(`⚠️ 处理出错: ${truncate(e.message, 500)}`);
      } catch {}
    }
  }

  /** 解析并执行命令。私聊普通文本 = 任务。 */
  async function routeCommand(text, isPrivate) {
    const [head, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    const raw = head.toLowerCase();
    const cmd = raw.replace(/^\/+/, "");
    // 私聊必须以 / 开头才是命令；群消息已剥离前缀，一律按命令处理
    const isCommand = isPrivate ? raw.startsWith("/") : true;

    if (!isCommand) {
      if (isPrivate) {
        // 聊天特化会话：直接聊天回复（像真人 QQ）
        if (state.chat.isChatTarget()) return state.chat.chatReply(text);
        if (state.chatMode) return state.chat.chatReply(text);
        if (config.privatePlainAsTask) return doAsk(text);
      }
      await state.bot.reply("❓ 未识别的消息。发送 /help 查看命令。");
      return;
    }
    // 纯净聊天模式：仅允许聊天相关与基础命令
    if (state.chatMode && !["chat", "help", "h", "ping", "status", "st"].includes(cmd)) {
      await state.bot.reply("💬 纯净聊天模式中，只聊天哦（可用 /chat /help /ping /status，/chat off 退出模式）");
      return;
    }
    switch (cmd) {
      case "chat":
        await state.chat.doChatMode(arg);
        break;
      case "chatbind":
      case "cb":
        await state.chat.doChatBind(arg);
        break;
      case "panel":
      case "pn":
        await state.bot.reply(`🖥️ QQ 控制面板：http://127.0.0.1:3080/qq-remote/panel\n（浏览器打开，登录失效时可一键重登并显示二维码）`);
        break;
      case "help":
      case "h":
        await state.bot.reply(helpText());
        break;
      case "ping":
      case "pong":
        await state.bot.reply("🏓 pong（OneBot 连接正常）");
        break;
      case "status":
      case "st":
        await state.bot.reply(statusText());
        break;
      case "sessions":
      case "ss":
        await state.bot.reply(sessionsText());
        break;
      case "session":
      case "s":
        if (!arg) {
          await state.bot.reply(sessionUsage());
          return;
        }
        await doSwitchSession(arg);
        break;
      case "title":
      case "rename":
        if (!arg) {
          await state.bot.reply("用法: /title <名称>（给当前目标会话重命名，之后可用标题切换）");
          return;
        }
        await doTitle(arg);
        break;
      case "newsession":
      case "new-session":
      case "ns":
        if (!arg) {
          await state.bot.reply("用法: /newsession <sessionId>（在当前工作区新建 agent 会话并切换）");
          return;
        }
        await doNewSession(arg);
        break;
      case "ask":
      case "task":
        if (!arg) {
          await state.bot.reply("用法: /ask <任务描述>");
          return;
        }
        await doAsk(arg);
        break;
      case "cancel":
      case "x":
        await doCancel();
        break;
      case "exec":
      case "run":
        if (!config.execAllowed) {
          await state.bot.reply("⛔ /exec 已被配置禁用（execAllowed=false）");
          return;
        }
        if (!arg) {
          await state.bot.reply("用法: /exec <shell 命令>");
          return;
        }
        await doExec(arg);
        break;
      case "progress":
      case "pg": {
        const n = parseInt(arg, 10) || 10;
        await state.bot.reply(progressText(n));
        break;
      }
      case "screenshot":
      case "sc":
        await doScreenshot();
        break;
      case "quiet":
      case "q":
        if (arg === "on" || arg === "1") config.autoReport = true;
        else if (arg === "off" || arg === "0") config.autoReport = false;
        await state.bot.reply(`进度自动汇报: ${config.autoReport ? "开 ✅" : "关 ⏸️"}`);
        break;
      default:
        await state.bot.reply(`❓ 未知命令 ${cmd}。发送 /help 查看命令。`);
    }
  }

  function helpText() {
    return [
      "🤖 DSH QQ 远程控制",
      "/ask <任务>   派发任务（私聊直接发消息也可）      /task",
      "/exec <命令>  在电脑上执行 shell 命令              /run",
      "/status       查看 agent 状态                     /st",
      "/progress [n] 查看最近进度（默认 10 条）          /pg",
      "/screenshot   截图并发送给你                      /sc",
      "/cancel       取消当前任务                        /x",
      "/sessions     列出会话（含标题）                  /ss",
      "/session <标题|id> 切换目标会话                  /s",
      "/title <名称>  给当前目标会话重命名",
      "/newsession <id> 新建会话并切换                  /ns",
      "/quiet on|off 开关进度自动推送                    /q",
      "/chat on|off  纯净聊天模式（/chat <名字> 切换）",
      "/chatbind on|off 绑定聊天特化会话                 /cb",
      "/panel        打开 QQ 控制面板                    /pn",
      "/ping         连通性测试（/pong 亦可）",
      "/help         本帮助（/h 亦可）",
    ].join("\n");
  }

  // ── Agent 桥接 ────────────────────────────────────────────────
  function agentsService() {
    return ctx.get("agents");
  }

  /** 解析目标 agent：配置 sessionId → 最近活跃会话。 */
  function resolveAgent() {
    const agents = agentsService();
    if (!agents) return null;
    if (config.targetSessionId) {
      const a = agents.get(config.targetSessionId);
      if (a) return a;
    }
    const list = agents.list();
    if (list.length === 0) return null;
    list.sort((a, b) => (state.lastEventAt.get(b.session.id) ?? 0) - (state.lastEventAt.get(a.session.id) ?? 0));
    return list[0];
  }

  /** 当前 agent 轮次数。 */
  function agentTurn(agent) {
    return agent.session.events.filter((e) => e.type === "turn/start").length;
  }

  /** 按标题包含匹配 agent（返回 [{agent, title}]）。 */
  function matchAgentsByTitle(query) {
    const agents = agentsService();
    if (!agents) return [];
    const out = [];
    for (const a of agents.list()) {
      const title = state.chat.sessionTitleOf(a.session);
      if (title && title.includes(query)) out.push({ agent: a, title });
    }
    return out;
  }

  /** /session 无参时的用法提示（含当前目标标题）。 */
  function sessionUsage() {
    const agents = agentsService();
    const list = agents ? agents.list() : [];
    const lines = ["用法: /session <序号|标题|id>"];
    if (config.targetSessionId) {
      const i = list.findIndex((a) => a.session.id === config.targetSessionId);
      if (i >= 0) {
        const title = state.chat.sessionTitleOf(list[i].session) ?? "未命名";
        lines.push(`当前目标: ${i + 1}. 「${title}」 ${config.targetSessionId}`);
      } else {
        lines.push(`当前目标: ${config.targetSessionId}`);
      }
    } else {
      lines.push("当前目标: 自动-最近活跃（/sessions 查看列表）");
    }
    return lines.join("\n");
  }

  /** 切换目标会话：优先序号，其次 id 精确，最后标题包含匹配。 */
  async function doSwitchSession(query) {
    const agents = agentsService();
    const list = agents ? agents.list() : [];
    // 1) 序号（/sessions 列表中的 1-based 序号）
    const idx = Number.parseInt(query, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) {
      const target = list[idx - 1];
      config.targetSessionId = target.session.id;
      const title = state.chat.sessionTitleOf(target.session);
      await state.bot.reply(`✅ 已切换到 ${idx}. ${title ? `「${title}」` : target.session.id}`);
      return;
    }
    // 2) id 精确
    if (agents) {
      const byId = agents.get(query);
      if (byId) {
        config.targetSessionId = query;
        await state.bot.reply(`✅ 目标会话已设为 ${query}`);
        return;
      }
    }
    // 3) 标题包含匹配
    const hits = matchAgentsByTitle(query);
    if (hits.length === 1) {
      config.targetSessionId = hits[0].agent.session.id;
      await state.bot.reply(`✅ 已按标题「${hits[0].title}」切换到 ${hits[0].agent.session.id}`);
      return;
    }
    if (hits.length > 1) {
      await state.bot.reply(`🔀 标题「${query}」匹配到多个会话，请用序号或更精确的标题：\n` +
        hits.map((h) => `• 「${h.title}」`).join("\n"));
      return;
    }
    await state.bot.reply(`❌ 未找到「${query}」（/sessions 看序号列表）`);
  }

  /** 给当前目标会话重命名。 */
  async function doTitle(title) {
    const agent = resolveAgent();
    if (!agent) {
      await state.bot.reply("❌ 没有可用的 agent 会话");
      return;
    }
    const st = ctx.get("sessionTitle");
    if (!st) {
      await state.bot.reply("❌ sessionTitle 服务不可用");
      return;
    }
    try {
      const snap = st.rename(agent.session, title);
      await state.bot.reply(`✅ 已重命名: 「${snap.title}」（${agent.session.id}）\n之后可用 /session ${snap.title} 切换`);
    } catch (e) {
      await state.bot.reply(`⚠️ 重命名失败: ${e.message}`);
    }
  }

  // ── 任务 / 会话 / 执行 / 状态 ────────────────────────────────
  async function doAsk(task) {
    const agent = resolveAgent();
    if (!agent) {
      await state.bot.reply("❌ 没有可用的 agent 会话（/sessions 查看，/session <id> 指定）");
      return;
    }
    const startTurn = agentTurn(agent);
    state.activeTask = { sessionId: agent.session.id, startTurn, startedAt: Date.now() };
    agent.followup(createUserMessage({
      content: [{ type: "text", text: task }],
      source: { kind: "user" },
    }));
    await state.bot.reply([
      `✅ 任务已派发\n📌 会话: ${agent.session.id}\n📝 任务: ${truncate(task, 200)}`,
      `🔔 进度将自动回传（/quiet off 可关），/cancel 可取消，/screenshot 可看屏幕。`,
    ].join("\n"));
  }

  async function doCancel() {
    const agent = resolveAgent();
    if (!agent) {
      await state.bot.reply("❌ 没有可用的 agent 会话");
      return;
    }
    try {
      agent.cancel("qq-remote: 用户在 QQ 上取消");
      await state.bot.reply("⏹️ 已发送取消指令");
    } catch (e) {
      await state.bot.reply(`⚠️ 取消失败: ${e.message}`);
    }
  }

  /** 在当前工作区新建 agent 会话并切换目标。
   *  注意：必须在根上下文（ctx.root）调用 agents.create —— 否则 agent 生命周期
   *  绑定在插件 fiber 上，插件一重载/重注入会话就会被销毁。 */
  async function doNewSession(id) {
    const agents = ctx.root.get("agents");
    if (!agents) {
      await state.bot.reply("❌ agents 服务不可用");
      return;
    }
    if (agents.get(id)) {
      await state.bot.reply(`❌ 会话已存在: ${id}（可直接 /session ${id} 切换）`);
      return;
    }
    const current = resolveAgent();
    const cwd = config.execCwd || current?.session?.header?.cwd || process.cwd();
    let selection;
    try {
      selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    } catch {}
    try {
      const { agent } = await agents.create({
        sessionId: id,
        meta: { cwd },
        agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
      });
      // 新会话默认以 id 为标题（之后可用 /title 修改）
      try {
        ctx.get("sessionTitle")?.rename(agent.session, id);
      } catch {}
      config.targetSessionId = id;
      await state.bot.reply([
        "✅ 已新建会话并切换目标",
        `📌 session: ${agent.session.id}`,
        `🏷️ 标题: ${id}（可用 /title <名称> 修改）`,
        `📂 cwd: ${cwd}`,
        `🤖 模型: ${selection ? `${selection.provider}/${selection.model}` : "默认"}`,
        "现在 /ask <任务> 将派发到该会话",
      ].join("\n"));
    } catch (e) {
      await state.bot.reply(`⚠️ 新建会话失败: ${e.message}`);
    }
  }

  async function doExec(cmd) {
    const agent = resolveAgent();
    let cwd = config.execCwd || agent?.session?.header?.cwd || process.cwd();
    if (!fs.existsSync(cwd)) cwd = process.cwd();
    await state.bot.reply(`⚙️ 执行中（cwd=${cwd}，超时 ${Math.round(config.execTimeoutMs / 1000)}s）…\n$ ${truncate(cmd, 300)}`);
    const res = await runProcess("/bin/bash", ["-c", cmd], { timeout: config.execTimeoutMs, cwd });
    const out = [res.out, res.err].filter((s) => s && s.trim()).join("\n");
    const head = res.timedOut ? "⏱️ 超时已终止（SIGKILL）" : `exit=${res.code ?? res.signal}`;
    await state.bot.reply(`${head}\n${out ? truncate(out, config.maxMessageLen - 100) : "（无输出）"}`);
  }

  async function doScreenshot() {
    await state.bot.reply("📸 正在截取屏幕…");
    try {
      const shot = await takeScreenshot(config);
      await state.bot.sendImage(state.controller.userId, state.controller.groupId, shot.base64, `📸 屏幕截图 (${Math.round(fs.statSync(shot.file).size / 1024)}KB)`);
    } catch (e) {
      await state.bot.reply(`⚠️ 截图失败: ${e.message}`);
    }
  }

  function statusText() {
    const agent = resolveAgent();
    if (!agent) return "❌ 没有可用的 agent 会话";
    const phase = agent.phase;
    const lines = [
      `📊 会话: ${agent.session.id}`,
      `状态: ${agent.status}${phase?.kind === "running" ? `（第 ${phase.turn} 轮 / 第 ${phase.step} 步）` : ""}`,
      `模型: ${agent.options?.provider}/${agent.options?.model ?? "?"}`,
    ];
    if (agent.status === "running" && phase?.kind === "running") {
      const recent = agent.session.events.slice(-30).reverse().find((e) =>
        e.type === "tool/call" || e.type === "assistant/message");
      if (recent) {
        lines.push(recent.type === "tool/call"
          ? `正在: 🔧 ${recent.data.name}`
          : `正在: 🤖 ${truncate(extractAssistantText(recent.data.message), 200)}`);
      }
    }
    const last = [...agent.session.events].reverse().find((e) => e.type === "turn/end");
    if (last) lines.push(`最近一轮: 第 ${last.data.turn} 轮 [${last.data.reason?.kind}]`);
    if (state.activeTask) lines.push(`跟踪任务: 进行中（${Math.round((Date.now() - state.activeTask.startedAt) / 1000)}s）`);
    return lines.join("\n");
  }

  function sessionsText() {
    const agents = agentsService();
    if (!agents) return "❌ agents 服务不可用";
    const list = agents.list();
    if (list.length === 0) return "❌ 当前没有 agent 会话";
    const lines = [`📋 会话列表（${list.length} 个）:`];
    list.forEach((a, i) => {
      const title = state.chat.sessionTitleOf(a.session) ?? "未命名";
      const status = a.status === "running" ? "进行中" : "空闲";
      const mark = a.session.id === config.targetSessionId ? " 🎯" : "";
      lines.push(`${i + 1}. 「${title}」 ${a.session.id} [${status}] 第 ${agentTurn(a)} 轮${mark}`);
    });
    lines.push("💡 /session <序号|标题|id> 切换");
    return lines.join("\n");
  }

  function progressText(n) {
    const agent = resolveAgent();
    if (!agent) return "❌ 没有可用的 agent 会话";
    const interesting = agent.session.events.filter((e) => formatEventLine(e));
    const tail = interesting.slice(-n);
    if (tail.length === 0) return "📭 暂无进度事件";
    const lines = tail.map((e) => formatEventLine(e));
    return `📜 最近 ${tail.length} 条进度:\n` + lines.join("\n");
  }

  // ── 进度推送 ──────────────────────────────────────────────────
  function enqueueReport(line) {
    if (!config.autoReport || !state.controller || state.disposed) return;
    state.pendingReports.push(line);
    const now = Date.now();
    const wait = Math.max(0, config.reportThrottleMs - (now - state.lastReportAt));
    if (wait === 0) return flushReports();
    if (!state.pendingTimer) state.pendingTimer = setTimeout(flushReports, wait);
  }

  async function flushReports() {
    state.pendingTimer = null;
    if (state.pendingReports.length === 0 || state.disposed) return;
    let lines = state.pendingReports;
    state.pendingReports = [];
    if (lines.length > 3) {
      lines = [...lines.slice(0, 2), `…（另有 ${lines.length - 2} 条进展，/progress 查看）`];
    }
    state.lastReportAt = Date.now();
    try {
      await state.bot.reply(lines.join("\n"));
    } catch (e) {
      log.warn(`[qq-remote] 进度推送失败: ${e.message}`);
    }
  }

  /** 直接发送一条汇报（phase 模式用，低频不节流）。 */
  async function sendReport(text) {
    if (!config.autoReport || !state.controller || state.disposed) return;
    try {
      await state.bot.reply(text);
    } catch (e) {
      log.warn(`[qq-remote] 汇报发送失败: ${e.message}`);
    }
  }

  // ── phase 模式：阶段性总结汇报 ────────────────────────────────
  /** 当前轮次的阶段收集器。 */
  function resetPhaseState() {
    state.phaseState = {
      turn: 0,
      step: 0,
      toolCalls: 0,
      lastTools: [],
      lastAssistant: "",
      startedAt: Date.now(),
    };
  }

  function noteTool(name, args) {
    if (!state.phaseState) resetPhaseState();
    state.phaseState.toolCalls += 1;
    let brief = name;
    try {
      brief = `${name}(${truncate(JSON.stringify(args ?? {}), 80)})`;
    } catch {}
    state.phaseState.lastTools.push(brief);
    if (state.phaseState.lastTools.length > 3) state.phaseState.lastTools.shift();
  }

  /** 轮次小结。 */
  async function phaseTurnSummary(event) {
    const st = state.phaseState;
    if (!st) return;
    const secs = Math.round((Date.now() - st.startedAt) / 1000);
    const lines = [`📊 第 ${event.data.turn} 轮小结（用时 ${secs}s）`];
    if (st.toolCalls > 0) lines.push(`🔧 工具调用 ${st.toolCalls} 次${st.lastTools.length ? "：" + st.lastTools.join("、") : ""}`);
    if (st.lastAssistant) lines.push(`🤖 ${truncate(st.lastAssistant, 200)}`);
    lines.push(`状态: ${event.data.reason?.kind ?? "?"}`);
    await sendReport(lines.join("\n"));
  }

  /** 任务完成总结。 */
  async function phaseTaskSummary(session, task, endEvent) {
    const st = state.phaseState;
    const secs = Math.round((Date.now() - task.startedAt) / 1000);
    const reason = endEvent.data.reason;
    const kind = reason?.kind ?? "?";
    // 找任务开始后的最后一条 assistant 文本
    const events = session.events;
    const startIdx = events.findIndex((e) => e.type === "turn/start" && e.data.turn === task.startTurn + 1);
    let finalText = "";
    if (startIdx >= 0) {
      for (const e of events.slice(startIdx)) {
        if (e.type === "assistant/message") {
          const t = extractAssistantText(e.data.message);
          if (t) finalText = t;
        }
      }
    }
    const lines = [
      kind === "completed" ? "✅ 任务完成" : kind === "error" ? "❌ 任务出错" : `🏁 任务结束 [${kind}]`,
      finalText ? `📄 结果: ${truncate(finalText, 600)}` : "",
      `⏱️ 用时 ${secs}s${st && st.toolCalls > 0 ? `，工具调用 ${st.toolCalls} 次` : ""}（/progress 看详情）`,
    ].filter(Boolean).join("\n");
    await sendReport(lines);
  }

  /** 长任务心跳汇报。 */
  async function phaseHeartbeat() {
    if (!state.activeTask) return;
    const agent = resolveAgent();
    const mins = Math.round((Date.now() - state.activeTask.startedAt) / 60000);
    const st = state.phaseState;
    const lines = [`⏳ 任务进行中（已 ${mins} 分钟）`];
    if (agent?.phase?.kind === "running") lines.push(`• 第 ${agent.phase.turn} 轮 / 第 ${agent.phase.step} 步`);
    if (st?.lastTools.length) lines.push(`• 最近: 🔧 ${st.lastTools.at(-1)}`);
    if (st?.lastAssistant) lines.push(`• 🤖 ${truncate(st.lastAssistant, 120)}`);
    await sendReport(lines.join("\n"));
  }

  function startHeartbeat() {
    if (state.disposed || state.heartbeatTimer || !config.autoReport) return;
    state.heartbeatTimer = setInterval(() => {
      phaseHeartbeat().catch(() => {});
    }, Math.max(config.phaseIntervalMs, 30000));
  }

  /** phase 模式事件处理：收集 + 阶段触发。 */
  function handlePhaseEvent(session, event) {
    const watchId = state.activeTask?.sessionId ?? resolveAgent()?.session?.id;
    if (!watchId || session.id !== watchId) return;

    // 任务完成检测：track 的会话轮次推进 → 汇总最终结果
    if (state.activeTask && event.type === "turn/end" && event.data.turn >= state.activeTask.startTurn + 1) {
      const task = state.activeTask;
      state.activeTask = null;
      phaseTaskSummary(session, task, event).catch(() => {});
      return;
    }

    switch (event.type) {
      case "turn/start":
        resetPhaseState();
        state.phaseState.turn = event.data.turn;
        break;
      case "step/start":
        if (!state.phaseState) resetPhaseState();
        state.phaseState.step = event.data.step;
        break;
      case "tool/call":
        noteTool(event.data.name, event.data.arguments);
        break;
      case "tool/result": {
        const block = event.data.message?.content?.[0];
        if (block?.isError || event.data.error) {
          // 出错即时汇报（重要异常不等阶段总结）
          const errText = truncate(block?.content?.[0]?.text ?? event.data.error?.message ?? "未知错误", 200);
          sendReport(`⚠️ 工具出错: ${errText}`).catch(() => {});
        }
        break;
      }
      case "assistant/message": {
        const t = extractAssistantText(event.data.message);
        if (t && state.phaseState) state.phaseState.lastAssistant = t;
        break;
      }
      case "turn/end":
        // 无跟踪任务时的轮次小结（有任务时上面已走完成总结）
        phaseTurnSummary(event).catch(() => {});
        break;
      default:
        break;
    }
  }

  /** session/event 观察者：记录活跃度 + 按模式生成汇报。 */
  function onSessionEvent(session, event) {
    state.lastEventAt.set(session.id, Date.now());
    if (config.reportMode === "phase") {
      handlePhaseEvent(session, event);
      return;
    }
    // live 模式：实时流水（原逻辑）
    const watchId = state.activeTask?.sessionId ?? resolveAgent()?.session?.id;
    if (!watchId || session.id !== watchId) return;

    // 任务完成检测：track 的会话轮次推进 → 汇总最终结果
    if (state.activeTask && event.type === "turn/end" && event.data.turn >= state.activeTask.startTurn + 1) {
      const task = state.activeTask;
      state.activeTask = null;
      const reason = event.data.reason;
      const kind = reason?.kind ?? "?";
      // 找任务开始后的最后一条 assistant 文本
      const events = session.events;
      const startIdx = events.findIndex((e) => e.type === "turn/start" && e.data.turn === task.startTurn + 1);
      let finalText = "";
      if (startIdx >= 0) {
        for (const e of events.slice(startIdx)) {
          if (e.type === "assistant/message") {
            const t = extractAssistantText(e.data.message);
            if (t) finalText = t;
          }
        }
      }
      const report = [
        kind === "completed" ? "✅ 任务完成" : kind === "error" ? "❌ 任务出错" : `🏁 任务结束 [${kind}]`,
        finalText ? `📄 结果: ${truncate(finalText, 600)}` : "",
        `⏱️ 用时 ${Math.round((Date.now() - task.startedAt) / 1000)}s（/progress 查看更多）`,
      ].filter(Boolean).join("\n");
      enqueueReport(report);
      return;
    }

    const line = formatEventLine(event);
    if (line) enqueueReport(line);
  }

  // ── Agent 可用工具（会话内主动汇报 / 截图） ───────────────────
  function registerTools() {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: "qq_report",
      description: "向远程 QQ 控制端发送一条文本消息（进度汇报、结果摘要、需要用户确认的问题）。仅当有 QQ 控制端绑定（用户通过 QQ 发过命令）时可用。",
      parameters: {
        text: { type: "string", required: true, description: "要发送给 QQ 用户的文本" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            note: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.note }],
      },
      async execute(args) {
        if (!state.controller) return { ok: false, note: "没有绑定的 QQ 控制端（用户尚未通过 QQ 发过命令）" };
        try {
          await state.bot.sendText(state.controller.userId, state.controller.groupId, truncate(args.text, config.maxMessageLen));
          return { ok: true, note: "已通过 QQ 发送" };
        } catch (e) {
          return { ok: false, note: `QQ 发送失败: ${e.message}` };
        }
      },
    })));

    ctx.effect(() => ctx.tools.register(defineTool({
      name: "qq_screenshot",
      description: "截取电脑屏幕，并把截图作为图片消息发送给远程 QQ 控制端。用于向用户展示当前界面状态。",
      parameters: {
        caption: { type: "string", description: "附加在截图前的说明文字（可选）" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            note: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.note }],
      },
      async execute(args) {
        if (!state.controller) return { ok: false, note: "没有绑定的 QQ 控制端（用户尚未通过 QQ 发过命令）" };
        try {
          const shot = await takeScreenshot(config);
          await state.bot.sendImage(state.controller.userId, state.controller.groupId, shot.base64, args.caption ? `📸 ${args.caption}` : undefined);
          return { ok: true, note: "截图已发送到 QQ" };
        } catch (e) {
          return { ok: false, note: `截图失败: ${e.message}` };
        }
      },
    })));
  }

  return {
    handleMessageEvent,
    routeCommand,
    helpText,
    resolveAgent,
    onSessionEvent,
    startHeartbeat,
    registerTools,
  };
}
