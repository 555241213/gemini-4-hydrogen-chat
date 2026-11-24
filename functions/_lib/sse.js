/**
 * 多模型（DeepSeek V4.1 Flash / Gemini 4 / 自定义 OpenAI 兼容端点）流式代理与 503 容灾
 */

import {
  API_TIMEOUT_MS,
  DEFAULT_CONTEXT_TURNS,
  DEFAULT_SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
} from "./config.js";
import { getRecentMessages, getUserPersona, insertMessage, resolveRuntimeSettings } from "./db.js";

/**
 * 构造发送给 OpenAI 兼容端点的 messages 列表：
 * - 动态附加系统提示词
 * - 仅截取当前对话最近 N 轮（确保窗口起点为 user）
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

        const userPersona = await getUserPersona(db, userId);
        const effectiveSystemPrompt = userPersona || runtime.systemPrompt;

        const recentRows = await getRecentMessages(
          db,
          userId,
          conversationId,
          DEFAULT_CONTEXT_TURNS * 2,
        );
        const apiMessages = buildApiMessages(
          recentRows,
          DEFAULT_CONTEXT_TURNS,
          effectiveSystemPrompt,
        );

        const requestUpstream = async (targetModel, targetBaseUrl, targetApiKey) => {
          const requestBody = {
            model: targetModel,
            messages: apiMessages,
            max_tokens: MAX_OUTPUT_TOKENS,
            stream: true,
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
