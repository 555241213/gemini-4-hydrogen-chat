import { jsonResponse, requireAuthenticatedUser } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";
import {
  createMemory,
  deleteMemory,
  listUserMemories,
  updateMemory,
} from "../_lib/db.js";

const MAX_MEMORY_CHARS = 300;
const MAX_MEMORIES_PER_USER = 80;

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未完成数据库绑定。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const url = new URL(request.url);
  const characterId = url.searchParams.has("character_id")
    ? String(url.searchParams.get("character_id") || "").trim()
    : null;

  const memories = await listUserMemories(env.DB, user.userId, characterId);
  return jsonResponse({ memories });
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

  const content = typeof body.content === "string" ? body.content.trim() : "";
  const characterId = typeof body.character_id === "string" ? body.character_id.trim() : "";
  if (!content) {
    return jsonResponse({ detail: "记忆内容不能为空。" }, 400);
  }
  if (content.length > MAX_MEMORY_CHARS) {
    return jsonResponse({ detail: `单条记忆不能超过 ${MAX_MEMORY_CHARS} 个字符。` }, 400);
  }

  const existing = await listUserMemories(env.DB, user.userId, null);
  if (existing.length >= MAX_MEMORIES_PER_USER) {
    return jsonResponse(
      { detail: `记忆本最多保留 ${MAX_MEMORIES_PER_USER} 条，请先清理旧记忆。` },
      400,
    );
  }

  const memory = await createMemory(env.DB, user.userId, {
    characterId,
    content,
    source: "manual",
  });
  return jsonResponse({ memory }, 201);
}

export async function onRequestPatch({ request, env }) {
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

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ detail: "无效的记忆 ID。" }, 400);
  }

  let content;
  if (Object.prototype.hasOwnProperty.call(body, "content")) {
    content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return jsonResponse({ detail: "记忆内容不能为空。" }, 400);
    }
    if (content.length > MAX_MEMORY_CHARS) {
      return jsonResponse({ detail: `单条记忆不能超过 ${MAX_MEMORY_CHARS} 个字符。` }, 400);
    }
  }

  const updated = await updateMemory(env.DB, user.userId, id, {
    content,
    enabled: Object.prototype.hasOwnProperty.call(body, "enabled")
      ? Boolean(body.enabled)
      : undefined,
    characterId: Object.prototype.hasOwnProperty.call(body, "character_id")
      ? String(body.character_id || "").trim()
      : undefined,
  });

  if (!updated) {
    return jsonResponse({ detail: "未找到该条记忆。" }, 404);
  }
  return jsonResponse({ memory: updated });
}

export async function onRequestDelete({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未完成数据库绑定。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ detail: "无效的记忆 ID。" }, 400);
  }

  await deleteMemory(env.DB, user.userId, id);
  return jsonResponse({ ok: true });
}
