import { jsonResponse, requireAuthenticatedUser } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";
import { clearUserMessages, listUserMessages } from "../_lib/db.js";

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  if (!config.configured) {
    return jsonResponse({ detail: "服务尚未完成初始化配置。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const messages = await listUserMessages(env.DB, user.userId);
  return jsonResponse({ messages });
}

export async function onRequestDelete({ request, env }) {
  const config = loadConfig(env);
  if (!config.configured) {
    return jsonResponse({ detail: "服务尚未完成初始化配置。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  await clearUserMessages(env.DB, user.userId);
  return jsonResponse({ ok: true });
}
