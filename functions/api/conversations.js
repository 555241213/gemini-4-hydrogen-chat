import { jsonResponse, requireAuthenticatedUser } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";
import {
  createConversation,
  deleteConversation,
  getConversation,
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

  const conversations = await listUserConversations(env.DB, user.userId);
  return jsonResponse({ conversations });
}

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未绑定数据库。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  let title = "新对话";
  try {
    const body = await request.json();
    if (body && typeof body.title === "string" && body.title.trim()) {
      title = body.title.trim().slice(0, 30);
    }
  } catch {
    // 允许空请求体新建默认对话
  }

  const conversation = await createConversation(env.DB, user.userId, title);
  return jsonResponse({ conversation }, 201);
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
  const convId = String(url.searchParams.get("id") || "").trim();
  if (!convId) {
    return jsonResponse({ detail: "缺少对话 ID。" }, 400);
  }

  const existing = await getConversation(env.DB, user.userId, convId);
  if (!existing) {
    return jsonResponse({ detail: "未找到该对话。" }, 404);
  }

  await deleteConversation(env.DB, user.userId, convId);
  return jsonResponse({ ok: true });
}
