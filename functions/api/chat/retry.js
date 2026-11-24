import { jsonResponse, requireAuthenticatedUser } from "../../_lib/auth.js";
import { loadConfig } from "../../_lib/config.js";
import { getConversation, getLastMessage } from "../../_lib/db.js";
import { createChatSseResponse } from "../../_lib/sse.js";

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未完成数据库绑定。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  let conversationId = "";
  try {
    const body = await request.json();
    conversationId = String(body?.conversation_id || "").trim();
  } catch {
    return jsonResponse({ detail: "请求格式错误。" }, 400);
  }

  const conv = await getConversation(env.DB, user.userId, conversationId);
  if (!conv) {
    return jsonResponse({ detail: "未找到当前对话。" }, 404);
  }

  const last = await getLastMessage(env.DB, user.userId, conversationId);
  if (!last || last.role !== "user") {
    return jsonResponse({ detail: "当前没有可重试的提问。" }, 400);
  }

  return createChatSseResponse({
    db: env.DB,
    config,
    userId: user.userId,
    conversationId,
  });
}
