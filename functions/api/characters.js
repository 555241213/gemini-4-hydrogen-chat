import { jsonResponse, requireAuthenticatedUser } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";
import {
  createCharacter,
  deleteCharacter,
  getCharacterById,
  listUserCharacters,
  updateCharacter,
} from "../_lib/db.js";

const MAX_FIELD_LEN = 2000;

function validateCharacterFields(body, requireName = true) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (requireName && !name) {
    return { error: "角色昵称不能为空。" };
  }
  if (name.length > 30) {
    return { error: "角色昵称不能超过 30 个字符。" };
  }
  const avatar = typeof body.avatar === "string" ? body.avatar.trim() : "";
  if (avatar.length > 16) {
    return { error: "角色头像字符过长（请使用 Emoji 或简短符号）。" };
  }

  for (const field of ["personality", "catchphrase", "background", "examples", "first_message"]) {
    if (typeof body[field] === "string" && body[field].length > MAX_FIELD_LEN) {
      return { error: `角色字段 ${field} 不能超过 ${MAX_FIELD_LEN} 个字符。` };
    }
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未完成数据库绑定。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const characters = await listUserCharacters(env.DB, user.userId);
  return jsonResponse({ characters });
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

  const err = validateCharacterFields(body, true);
  if (err) return jsonResponse({ detail: err.error }, 400);

  const existing = await listUserCharacters(env.DB, user.userId, { autoSeed: true });
  if (existing.length >= 20) {
    return jsonResponse({ detail: "最多可保存 20 个角色，请先删除不用的角色。" }, 400);
  }

  const character = await createCharacter(env.DB, user.userId, body);
  return jsonResponse({ character }, 201);
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

  const charId = typeof body.id === "string" ? body.id.trim() : "";
  if (!charId) {
    return jsonResponse({ detail: "缺少角色 ID。" }, 400);
  }

  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const err = validateCharacterFields(body, hasName);
  if (err) return jsonResponse({ detail: err.error }, 400);

  const updated = await updateCharacter(env.DB, user.userId, charId, body);
  if (!updated) {
    return jsonResponse({ detail: "未找到该角色。" }, 404);
  }
  return jsonResponse({ character: updated });
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
  const charId = String(url.searchParams.get("id") || "").trim();
  if (!charId) {
    return jsonResponse({ detail: "缺少角色 ID。" }, 400);
  }

  const target = await getCharacterById(env.DB, user.userId, charId);
  if (!target) {
    return jsonResponse({ detail: "未找到该角色。" }, 404);
  }

  const all = await listUserCharacters(env.DB, user.userId, { autoSeed: false });
  if (all.length <= 1) {
    return jsonResponse({ detail: "至少需要保留一个角色，你可以直接编辑当前角色。" }, 400);
  }

  await deleteCharacter(env.DB, user.userId, charId);
  const remaining = await listUserCharacters(env.DB, user.userId, { autoSeed: false });
  if (target.is_default && remaining.length > 0) {
    await updateCharacter(env.DB, user.userId, remaining[0].id, { is_default: true });
  }
  return jsonResponse({ ok: true });
}
