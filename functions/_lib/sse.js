/**
 * 多模型（DeepSeek V4.1 Flash / Gemini 4 / 自定义 OpenAI 兼容端点）流式代理与 503 容灾
 */

import {
  API_TIMEOUT_MS,
  DEFAULT_CONTEXT_TURNS,
  DEFAULT_SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
  MULTI_BUBBLE_INSTRUCTION,
} from "./config.js";
import {
  getCharacterById,
  getConversation,
  getEnabledMemoriesForPrompt,
  getRecentMessages,
  getUserPersona,
  insertMessage,
  resolveRuntimeSettings,
} from "./db.js";

/**
 * 解析角色示例对话（Few-shot），支持“用户:/User:”与“角色名:/AI:/Assistant:”前缀。
 */
export function parseExampleDialoguePairs(examplesText, characterName = "") {
  const raw = String(examplesText || "").trim();
  if (!raw) return { pairs: [], rawBlock: "" };

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pairs = [];
  const escapedName = characterName ? characterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const userPrefixRe = /^(?:用户|我|User)\s*[：:]\s*(.+)$/i;
  const botPrefixRe = escapedName
    ? new RegExp(`^(?:AI|助手|Assistant|角色|${escapedName})\\s*[：:]\\s*(.+)$`, "i")
    : /^(?:AI|助手|Assistant|角色)\s*[：:]\s*(.+)$/i;

  for (const line of lines) {
    const uMatch = line.match(userPrefixRe);
    if (uMatch) {
      pairs.push({ role: "user", content: uMatch[1].trim() });
      continue;
    }
    const bMatch = line.match(botPrefixRe);
    if (bMatch) {
      pairs.push({ role: "assistant", content: bMatch[1].trim() });
      continue;
    }
    if (pairs.length > 0) {
      pairs[pairs.length - 1].content += `\n${line}`;
    } else {
      return { pairs: [], rawBlock: raw };
    }
  }

  // 保证成对且以 user 开头、assistant 结尾，避免破坏上下文交替结构
  if (pairs.length >= 2 && pairs[0].role === "user") {
    const valid = pairs.length % 2 === 0 ? pairs : pairs.slice(0, -1);
    if (valid.length >= 2) {
      return { pairs: valid, rawBlock: "" };
    }
  }
  return { pairs: [], rawBlock: raw };
}

/**
 * 组装最终生效的 System Prompt 与 Few-shot 对话示例：
 * - 若对话绑定了结构化角色，组装昵称、性格、口癖、背景、对话示例与分条指令
 * - 若未绑定角色，保持 userPersona || runtimeSystemPrompt（与旧版 100% 兼容）
 * - 若存在已启用的记忆本条目，附加到系统提示词末尾
 */
export function buildEffectivePromptBundle({
  character = null,
  memories = [],
  userPersona = "",
  runtimeSystemPrompt = DEFAULT_SYSTEM_PROMPT,
}) {
  let basePrompt = "";
  let fewShotMessages = [];

  if (character) {
    const sections = [`你正在扮演角色「${character.name}」，请始终沉浸式保持该身份与语气，不要跳出角色。`];
    if (character.personality) sections.push(`【性格特点】${character.personality}`);
    if (character.catchphrase) sections.push(`【口癖与说话风格】${character.catchphrase}`);
    if (character.background) sections.push(`【背景设定】${character.background}`);
    sections.push(
      "请根据用户输入自行决定回复长短：简单聊天简短自然回应，复杂问题再充分展开。" +
        MULTI_BUBBLE_INSTRUCTION,
    );

    const parsedExamples = parseExampleDialoguePairs(character.examples, character.name);
    fewShotMessages = parsedExamples.pairs;
    if (parsedExamples.rawBlock) {
      sections.push(`【对话风格示例】\n${parsedExamples.rawBlock}`);
    }
    basePrompt = sections.join("\n\n");
  } else {
    basePrompt = String(userPersona || "").trim() || String(runtimeSystemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
  }

  const activeMemories = Array.isArray(memories)
    ? memories.filter((m) => m && m.enabled !== false && String(m.content || "").trim())
    : [];

  if (activeMemories.length > 0) {
    const memLines = [];
    let totalChars = 0;
    for (const mem of activeMemories) {
      const line = `- ${String(mem.content).trim()}`;
      if (totalChars + line.length > 1800) break;
      memLines.push(line);
      totalChars += line.length;
    }
    if (memLines.length > 0) {
      basePrompt +=
        "\n\n【关于用户的长期记忆本（请自然运用这些已知事实，不要生硬机械地复述）】\n" +
        memLines.join("\n");
    }
  }

  return { systemPrompt: basePrompt, fewShotMessages };
}

/**
 * 构造发送给 OpenAI 兼容端点的 messages 列表：
 * - 动态附加系统提示词与 Few-shot 对话示例
 * - 仅截取当前对话最近 N 轮（确保窗口起点为 user）
 * - 单轮传图策略：仅当前最新一轮 user 消息携带图片，历史轮次仅保留文本
 */
export function buildApiMessages(
  historyRows,
  contextTurns = DEFAULT_CONTEXT_TURNS,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  fewShotMessages = [],
) {
  const apiMessages = [];
  const cleanedSystem = String(systemPrompt || "").trim();
  if (cleanedSystem) {
    apiMessages.push({ role: "system", content: cleanedSystem });
  }

  if (Array.isArray(fewShotMessages) && fewShotMessages.length > 0) {
    for (const item of fewShotMessages) {
      if (item && (item.role === "user" || item.role === "assistant") && item.content) {
        apiMessages.push({ role: item.role, content: String(item.content) });
      }
    }
  }

  const maxWindow = contextTurns * 2;
  const windowRows = historyRows.slice(-maxWindow);
  while (windowRows.length && windowRows[0].role !== "user") {
    windowRows.shift();
  }

  const lastIndex = windowRows.length - 1;
  windowRows.forEach((row, idx) => {
    const role = row.role;
    const textContent = row.content || "";
    const imageData = row.image_data || row.image_url || null;
    const isCurrentTurn = idx === lastIndex && role === "user";

    if (isCurrentTurn && imageData) {
      const promptText = textContent.trim() || "请帮我看看这张图片。";
      apiMessages.push({
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: imageData } },
        ],
      });
    } else {
      const fallbackText =
        role === "user" && !textContent.trim() && imageData
          ? "[用户此前发了一张图片]"
          : textContent;
      apiMessages.push({ role, content: fallbackText });
    }
  });

  return apiMessages;
}

export function extractSafeUpstreamDetail(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const errObj = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    const msg = errObj?.message || parsed?.message || "";
    if (msg) return String(msg).replace(/\s+/g, " ").slice(0, 180);
  } catch {
    // 非 JSON 时截取纯文本前缀
  }
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 140);
}

export function formatUpstreamError(status, rawDetail = "") {
  const detail = extractSafeUpstreamDetail(rawDetail);
  const suffix = detail ? `（HTTP ${status}：${detail}）` : `（HTTP ${status}）`;

  if (status === 401) return `❌ 当前模型 API 密钥无效或已过期${suffix}，请联系管理员检查后台密钥配置。`;
  if (status === 403) return `❌ 当前密钥无权访问或节点地区受限${suffix}，请联系管理员核查。`;
  if (status === 404) return `❌ 服务模型或接口地址配置异常${suffix}，请联系管理员检查。`;
  if (status === 429) return `⏳ 当前请求太快或配额已达上限${suffix}，请稍等几秒再试。`;
  if (status === 400) return `⚠️ 请求参数或内容无法处理${suffix}，请核对后重试。`;
  return `⚠️ 模型服务暂时开小差了${suffix}，请稍后重试。`;
}

export function formatExceptionError(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "⌛ 响应有点慢超时了，请再试一次。";
  }
  return "🌐 网络连接暂时不稳定，请稍后重试。";
}

function encodeSseEvent(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function callModelWithFallback({
  runtime,
  messages,
  maxTokens = MAX_OUTPUT_TOKENS,
  stream = true,
  fetchImpl = fetch,
}) {
  const requestUpstream = async (targetModel, targetBaseUrl, targetApiKey) => {
    const requestBody = {
      model: targetModel,
      messages,
      max_tokens: maxTokens,
      stream,
    };
    if (runtime.reasoningEffort !== null) {
      requestBody.reasoning_effort = runtime.reasoningEffort;
    }

    return fetchImpl(`${targetBaseUrl}chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${targetApiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  };

  let upstreamRes = await requestUpstream(
    runtime.modelName,
    runtime.baseUrl,
    runtime.activeApiKey,
  );

  // 仅在 503（未计费且为临时高峰拥堵）时短暂等待后重试一次；若仍 503 则依次尝试备选模型链
  if (upstreamRes.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    upstreamRes = await requestUpstream(
      runtime.modelName,
      runtime.baseUrl,
      runtime.activeApiKey,
    );
    if (upstreamRes.status === 503 && runtime.fallbackModel) {
      const fallbackList = runtime.fallbackModel
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m && m !== runtime.modelName);
      for (const fbModel of fallbackList) {
        upstreamRes = await requestUpstream(
          fbModel,
          runtime.baseUrl,
          runtime.activeApiKey,
        );
        if (upstreamRes.status !== 503) break;
      }
    }
  }

  return upstreamRes;
}

/**
 * 发起流式请求并将结果以 SSE 推回前端，同时在成功结束后落库 D1。
 */
export function createChatSseResponse({
  db,
  config,
  userId,
  conversationId,
  preSavedUserMsg = null,
  updatedConversation = null,
  fetchImpl = fetch,
}) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (name, payload) => {
        controller.enqueue(encoder.encode(encodeSseEvent(name, payload)));
      };

      try {
        if (updatedConversation) {
          sendEvent("conversation_updated", { conversation: updatedConversation });
        }
        if (preSavedUserMsg) {
          sendEvent("user_saved", { message: preSavedUserMsg });
        }

        const runtime = await resolveRuntimeSettings(db, config);
        if (!runtime.activeApiKey) {
          sendEvent("error", {
            error: `❌ 当前模型（${runtime.modelName}）尚未配置对应的 API Key，请管理员进入后台填入密钥。`,
          });
          controller.close();
          return;
        }

        const conversation = await getConversation(db, userId, conversationId);
        const character =
          conversation && conversation.character_id
            ? await getCharacterById(db, userId, conversation.character_id)
            : null;
        const memories = await getEnabledMemoriesForPrompt(
          db,
          userId,
          character ? character.id : "",
        );
        const userPersona = character ? "" : await getUserPersona(db, userId);

        const promptBundle = buildEffectivePromptBundle({
          character,
          memories,
          userPersona,
          runtimeSystemPrompt: runtime.systemPrompt,
        });

        const recentRows = await getRecentMessages(
          db,
          userId,
          conversationId,
          DEFAULT_CONTEXT_TURNS * 2,
        );
        const apiMessages = buildApiMessages(
          recentRows,
          DEFAULT_CONTEXT_TURNS,
          promptBundle.systemPrompt,
          promptBundle.fewShotMessages,
        );

        const upstreamRes = await callModelWithFallback({
          runtime,
          messages: apiMessages,
          maxTokens: MAX_OUTPUT_TOKENS,
          stream: true,
          fetchImpl,
        });

        if (!upstreamRes.ok || !upstreamRes.body) {
          const rawErr = await upstreamRes.text().catch(() => "");
          console.error("Model upstream error", upstreamRes.status, rawErr.slice(0, 300));
          sendEvent("error", { error: formatUpstreamError(upstreamRes.status, rawErr) });
          controller.close();
          return;
        }

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        const contentParts = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith("data:")) continue;
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            let parsed;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const choices = parsed && Array.isArray(parsed.choices) ? parsed.choices : null;
            if (!choices || !choices.length) continue;

            const delta = choices[0] ? choices[0].delta : null;
            const contentPiece = delta && typeof delta.content === "string" ? delta.content : "";
            if (contentPiece) {
              contentParts.push(contentPiece);
              sendEvent("delta", { text: contentPiece });
            }
          }
        }

        const fullReply = contentParts.join("");
        if (!fullReply.trim()) {
          sendEvent("error", { error: "⚠️ 刚才没有收到完整回复，请换个说法再试一次。" });
          controller.close();
          return;
        }

        const savedAssistant = await insertMessage(db, {
          userId,
          conversationId,
          role: "assistant",
          content: fullReply,
          imageData: null,
        });
        sendEvent("done", { message: savedAssistant });
      } catch (err) {
        sendEvent("error", { error: formatExceptionError(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
