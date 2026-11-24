import { jsonResponse, requireAuthenticatedUser } from "../../_lib/auth.js";
import { loadConfig } from "../../_lib/config.js";
import { deleteMessageById, getLastMessage } from "../../_lib/db.js";
import { createChatSseResponse } from "../../_lib/sse.js";

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  if (!config.configured) {
    return jsonResponse({ detail: "服务尚未完成初始化配置。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const last = await getLastMessage(env.DB, user.userId);
  if (!last || last.role !== "assistant") {
    return jsonResponse({ detail: "当前没有可重新生成的回复。" }, 400);
  }

  await deleteMessageById(env.DB, user.userId, last.id);

  return createChatSseResponse({
    db: env.DB,
    config,
    userId: user.userId,
  });
}
