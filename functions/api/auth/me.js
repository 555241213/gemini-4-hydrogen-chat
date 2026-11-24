import { jsonResponse, requireAuthenticatedUser } from "../../_lib/auth.js";
import { loadConfig } from "../../_lib/config.js";

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未绑定数据库。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }
  return jsonResponse({
    user: {
      username: user.userId,
      display_name: user.userId,
      is_admin: Boolean(user.isAdmin),
    },
  });
}
