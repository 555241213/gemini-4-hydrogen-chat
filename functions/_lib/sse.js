/**
 * Gemini OpenAI 兼容接口流式代理、滑动窗口与单轮传图构造
 */

import {
  API_TIMEOUT_MS,
  DEFAULT_CONTEXT_TURNS,
  DEFAULT_SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
} from "./config.js";
import { getRecentMessages, insertMessage } from "./db.js";

/**
 * 构造发送给 Gemini OpenAI 兼容端点的 messages 列表：
 * - 动态附加系统提示词
 * - 仅截取最近 N 轮（确保窗口起点为 user）
 * - 单轮传图策略：仅当前最新一轮 user 消息携带图片，历史轮次仅保留文本
 */
export function buildApiMessages(
  historyRows,
  contextTurns = DEFAULT_CONTEXT_TURNS,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
) {
  const apiMessages = [];
  const cleanedSystem = String(systemPrompt || "").trim();
  if (cleanedSystem) {
    apiMessages.push({ role: "system", content: cleanedSystem });
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

export function formatUpstreamError(status) {
  if (status === 401) return "❌ 服务密钥无效或已过期，请联系管理员检查配置。";
  if (status === 403) return "❌ 当前密钥无权访问服务，请联系管理员核查权限。";
  if (status === 404) return "❌ 服务模型或接口地址配置异常，请联系管理员检查。";
  if (status === 429) return "⏳ 当前对话人数较多或请求太快，请稍等几秒再试。";
  if (status === 400) return "⚠️ 这条内容或图片格式无法处理，请换种说法或换张图片试试。";
  return "⚠️ 模型服务暂时开小差了，请稍后重试。";
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

/**
 * 发起流式请求并将结果以 SSE 推回前端，同时在成功结束后落库 D1。
 */
export function createChatSseResponse({
  db,
  config,
  userId,
  preSavedUserMsg = null,
  fetchImpl = fetch,
}) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (name, payload) => {
        controller.enqueue(encoder.encode(encodeSseEvent(name, payload)));
      };

      try {
        if (preSavedUserMsg) {
          sendEvent("user_saved", { message: preSavedUserMsg });
        }

        const recentRows = await getRecentMessages(db, userId, DEFAULT_CONTEXT_TURNS * 2);
        const apiMessages = buildApiMessages(recentRows);

        const requestBody = {
          model: config.modelName,
          messages: apiMessages,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
        };
        if (config.reasoningEffort !== null) {
          requestBody.reasoning_effort = config.reasoningEffort;
        }

        const upstreamRes = await fetchImpl(`${config.baseUrl}chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });

        if (!upstreamRes.ok || !upstreamRes.body) {
          sendEvent("error", { error: formatUpstreamError(upstreamRes.status) });
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

        // 仅在完整生成后才将助手回复写入 D1，杜绝残缺消息污染历史
        const savedAssistant = await insertMessage(db, {
          userId,
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
