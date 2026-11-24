import {
  authenticatePassword,
  buildSessionCookieHeader,
  createSessionToken,
  jsonResponse,
  resolveSessionSecret,
} from "../../_lib/auth.js";
import { loadConfig } from "../../_lib/config.js";

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  if (!config.configured) {
    return jsonResponse(
      { detail: `缺少必要配置：${config.missing.join("、")}` },
      503,
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

  const matched = await authenticatePassword(password, config.userEntries);
  if (!matched) {
    // 轻微延迟防暴力尝试
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
      },
    },
    200,
    {
      "Set-Cookie": buildSessionCookieHeader(token, request),
    },
  );
}
