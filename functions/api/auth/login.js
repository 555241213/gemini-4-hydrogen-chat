import {
  authenticatePassword,
  buildSessionCookieHeader,
  createSessionToken,
  getAllUserEntries,
  jsonResponse,
  resolveSessionSecret,
} from "../../_lib/auth.js";
import { loadConfig } from "../../_lib/config.js";
import { checkRateLimit } from "../../_lib/db.js";

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb || (!config.geminiApiKey && !config.deepseekApiKey)) {
    return jsonResponse(
      { detail: `缺少必要配置：${config.missing.join("、")}` },
      503,
    );
  }

  const clientIp = (request.headers.get("CF-Connecting-IP") || "unknown").trim();
  const limit = await checkRateLimit(env.DB, `login:${clientIp}`, 15, 300);
  if (!limit.allowed) {
    return jsonResponse(
      { detail: `⏳ 尝试次数过多，请在 ${limit.retryAfter} 秒后再试。` },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ detail: "请求格式错误。" }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password.trim()) {
    return jsonResponse({ detail: "请输入你的专属访问密码。" }, 400);
  }

  const allEntries = await getAllUserEntries(config, env.DB);
  if (!allEntries.length) {
    return jsonResponse({ detail: "尚未配置任何成员或管理员密码。" }, 503);
  }

  const matched = await authenticatePassword(password, allEntries);
  if (!matched) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return jsonResponse({ detail: "访问密码不正确，请核对后重试。" }, 401);
  }

  const secret = await resolveSessionSecret(config);
  const token = await createSessionToken(matched.userId, matched.password, secret);

  return jsonResponse(
    {
      user: {
        username: matched.userId,
        display_name: matched.userId,
        is_admin: Boolean(matched.isAdmin),
      },
    },
    200,
    {
      "Set-Cookie": buildSessionCookieHeader(token, request),
    },
  );
}
