import { jsonResponse, requireAuthenticatedUser } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";
import {
  clearUserConversationMessages,
  getConversation,
  listConversationMessages,
  listUserConversations,
} from "../_lib/db.js";

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未绑定数据库。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const url = new URL(request.url);
  let convId = String(url.searchParams.get("conversation_id") || "").trim();

  if (!convId) {
    const convs = await listUserConversations(env.DB, user.userId);
    if (!convs.length) {
      return jsonResponse({ conversation_id: null, messages: [] });
    }
    convId = convs[0].id;
  } else {
    const conv = await getConversation(env.DB, user.userId, convId);
    if (!conv) {
      return jsonResponse({ detail: "未找到该对话。" }, 404);
    }
  }

  const messages = await listConversationMessages(env.DB, user.userId, convId);
  return jsonResponse({ conversation_id: convId, messages });
}

export async function onRequestDelete({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未绑定数据库。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const url = new URL(request.url);
  const convId = String(url.searchParams.get("conversation_id") || "").trim();
  if (convId) {
    const conv = await getConversation(env.DB, user.userId, convId);
    if (!conv) {
      return jsonResponse({ detail: "未找到该对话。" }, 404);
    }
    await clearUserConversationMessages(env.DB, user.userId, convId);
  } else {
    await clearUserConversationMessages(env.DB, user.userId, null);
  }

  return jsonResponse({ ok: true });
}
