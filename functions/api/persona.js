import { jsonResponse, requireAuthenticatedUser } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";
import { getUserPersona, setUserPersona } from "../_lib/db.js";

const MAX_USER_PERSONA_CHARS = 4000;

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未完成数据库绑定。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const customPersona = await getUserPersona(env.DB, user.userId);
  return jsonResponse({
    custom_persona: customPersona,
    is_custom: Boolean(customPersona),
  });
}

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未完成数据库绑定。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ detail: "请求格式错误。" }, 400);
  }

  const raw = typeof body.system_prompt === "string" ? body.system_prompt.trim() : "";
  if (raw.length > MAX_USER_PERSONA_CHARS) {
    return jsonResponse(
      { detail: `个人人设不能超过 ${MAX_USER_PERSONA_CHARS.toLocaleString()} 个字符。` },
      400,
    );
  }

  const saved = await setUserPersona(env.DB, user.userId, raw);
  return jsonResponse({
    ok: true,
    custom_persona: saved,
    is_custom: Boolean(saved),
  });
}
