import { getAllUserEntries, jsonResponse, requireAdminUser } from "../../_lib/auth.js";
import { isAdminUsername, loadConfig, MAX_USERS } from "../../_lib/config.js";
import { deleteManagedUser, getUserMessageStats, upsertManagedUser } from "../../_lib/db.js";

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  const auth = await requireAdminUser(request, config, env.DB);
  if (!auth.user) return jsonResponse({ detail: auth.detail }, auth.status);

  const entries = await getAllUserEntries(config, env.DB);
  const stats = await getUserMessageStats(env.DB);

  const users = entries.map((u) => ({
    user_id: u.userId,
    is_admin: Boolean(u.isAdmin),
    source: u.source,
    message_count: stats[u.userId] || 0,
  }));

  return jsonResponse({ users, max_users: MAX_USERS });
}

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  const auth = await requireAdminUser(request, config, env.DB);
  if (!auth.user) return jsonResponse({ detail: auth.detail }, auth.status);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ detail: "请求格式错误。" }, 400);
  }

  const userId = String(body.user_id || "").trim();
  const password = String(body.password || "").trim();
  const isAdmin = Boolean(body.is_admin) || isAdminUsername(userId);

  if (!userId || userId.length > 24) {
    return jsonResponse({ detail: "成员昵称需为 1–24 个字符。" }, 400);
  }
  if (password.length < 4 || password.length > 128) {
    return jsonResponse({ detail: "密码长度需在 4–128 个字符之间。" }, 400);
  }

  const existing = await getAllUserEntries(config, env.DB);
  const alreadyExists = existing.some((u) => u.userId === userId);
  if (!alreadyExists && existing.length >= MAX_USERS + 1) {
    return jsonResponse({ detail: `最多支持配置 ${MAX_USERS} 位成员。` }, 400);
  }

  await upsertManagedUser(env.DB, { userId, password, isAdmin });
  return jsonResponse({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const config = loadConfig(env);
  const auth = await requireAdminUser(request, config, env.DB);
  if (!auth.user) return jsonResponse({ detail: auth.detail }, auth.status);

  const url = new URL(request.url);
  const userId = String(url.searchParams.get("user_id") || "").trim();
  if (!userId) {
    return jsonResponse({ detail: "缺少成员昵称。" }, 400);
  }
  if (userId === auth.user.userId) {
    return jsonResponse({ detail: "不能删除当前正在登录的管理员账户。" }, 400);
  }

  await deleteManagedUser(env.DB, userId);
  return jsonResponse({ ok: true });
}
