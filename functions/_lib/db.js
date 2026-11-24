/**
 * Cloudflare D1 存储层：
 * - conversations：按 user_id 隔离的多对话列表（支持新建对话、切换与单独删除）
 * - messages：每条对话下的聊天消息（兼容升级旧版无 conversation_id 的记录）
 * - app_settings：管理员后台实时切换模型、API Key 与思考深度的持久化配置
 * - managed_users：管理员在线增删/改密的成员列表（与环境变量 USER_PASSWORDS 合并）
 */

import {
  DEFAULT_CHARACTER_PRESETS,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  normalizeBaseUrl,
} from "./config.js";

let schemaInitPromise = null;

export async function ensureSchema(db) {
  if (!db) {
    throw new Error("未检测到 D1 数据库绑定（DB）。");
  }
  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS conversations (" +
            "id TEXT PRIMARY KEY, " +
            "user_id TEXT NOT NULL, " +
            "title TEXT NOT NULL, " +
            "character_id TEXT, " +
            "created_at INTEGER NOT NULL, " +
            "updated_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      try {
        await db.prepare("ALTER TABLE conversations ADD COLUMN character_id TEXT").run();
      } catch {
        // 列已存在时忽略
      }

      await db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC)",
        )
        .run();

      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS messages (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "user_id TEXT NOT NULL, " +
            "conversation_id TEXT, " +
            "msg_uid TEXT NOT NULL, " +
            "role TEXT NOT NULL, " +
            "content TEXT NOT NULL DEFAULT '', " +
            "image_data TEXT, " +
            "created_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      // 兼容旧表结构：若早先已建表且缺少 conversation_id 列则平滑补列
      try {
        await db.prepare("ALTER TABLE messages ADD COLUMN conversation_id TEXT").run();
      } catch {
        // 列已存在时忽略
      }

      await db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_messages_user_conv ON messages (user_id, conversation_id, id)",
        )
        .run();

      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS app_settings (" +
            "key TEXT PRIMARY KEY, " +
            "value TEXT NOT NULL, " +
            "updated_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS managed_users (" +
            "user_id TEXT PRIMARY KEY, " +
            "password TEXT NOT NULL, " +
            "is_admin INTEGER NOT NULL DEFAULT 0, " +
            "updated_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS user_preferences (" +
            "user_id TEXT PRIMARY KEY, " +
            "system_prompt TEXT NOT NULL, " +
            "updated_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS characters (" +
            "id TEXT PRIMARY KEY, " +
            "user_id TEXT NOT NULL, " +
            "name TEXT NOT NULL, " +
            "avatar TEXT NOT NULL DEFAULT '✦', " +
            "personality TEXT NOT NULL DEFAULT '', " +
            "catchphrase TEXT NOT NULL DEFAULT '', " +
            "background TEXT NOT NULL DEFAULT '', " +
            "examples TEXT NOT NULL DEFAULT '', " +
            "first_message TEXT NOT NULL DEFAULT '', " +
            "is_default INTEGER NOT NULL DEFAULT 0, " +
            "created_at INTEGER NOT NULL, " +
            "updated_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      await db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_characters_user ON characters (user_id, updated_at DESC)",
        )
        .run();

      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS memories (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "user_id TEXT NOT NULL, " +
            "character_id TEXT NOT NULL DEFAULT '', " +
            "content TEXT NOT NULL, " +
            "enabled INTEGER NOT NULL DEFAULT 1, " +
            "source TEXT NOT NULL DEFAULT 'manual', " +
            "created_at INTEGER NOT NULL, " +
            "updated_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      await db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (user_id, character_id, id DESC)",
        )
        .run();

      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS rate_limits (" +
            "bucket_key TEXT PRIMARY KEY, " +
            "count INTEGER NOT NULL, " +
            "reset_at INTEGER NOT NULL" +
          ")",
        )
        .run();
    })().catch((err) => {
      schemaInitPromise = null;
      throw err;
    });
  }
  return schemaInitPromise;
}

export function mapMessageRow(row) {
  return {
    id: row.id,
    msg_uid: row.msg_uid,
    conversation_id: row.conversation_id || null,
    role: row.role,
    content: row.content || "",
    image_url: row.image_data || null,
    created_at: row.created_at,
  };
}

export function summarizeTitle(text, hasImage = false) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return hasImage ? "图片对话" : "新对话";
  return cleaned.length > 20 ? `${cleaned.slice(0, 20)}...` : cleaned;
}

/**
 * 将旧版尚未归属 conversation_id 的历史记录自动迁移为一条默认对话，防止升级丢数据。
 */
export async function migrateLegacyMessages(db, userId) {
  await ensureSchema(db);
  const orphan = await db
    .prepare(
      "SELECT id, content, image_data, created_at FROM messages " +
        "WHERE user_id = ? AND (conversation_id IS NULL OR conversation_id = '') ORDER BY id ASC LIMIT 1",
    )
    .bind(userId)
    .first();

  if (!orphan) return null;

  const convId = crypto.randomUUID();
  const title = summarizeTitle(orphan.content, Boolean(orphan.image_data));
  const ts = orphan.created_at || Math.floor(Date.now() / 1000);

  await db
    .prepare(
      "INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(convId, userId, title, ts, ts)
    .run();

  await db
    .prepare(
      "UPDATE messages SET conversation_id = ? WHERE user_id = ? AND (conversation_id IS NULL OR conversation_id = '')",
    )
    .bind(convId, userId)
    .run();

  return convId;
}

export async function listUserConversations(db, userId) {
  await ensureSchema(db);
  await migrateLegacyMessages(db, userId);

  const res = await db
    .prepare(
      "SELECT id, user_id, title, character_id, created_at, updated_at " +
        "FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC",
    )
    .bind(userId)
    .all();

  return res.results || [];
}

export async function getConversation(db, userId, conversationId) {
  await ensureSchema(db);
  if (!conversationId) return null;
  const row = await db
    .prepare(
      "SELECT id, user_id, title, character_id, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?",
    )
    .bind(conversationId, userId)
    .first();
  return row || null;
}

export async function createConversation(db, userId, title = "新对话", characterId = null) {
  await ensureSchema(db);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const cleanCharId = characterId ? String(characterId).trim() : null;
  await db
    .prepare(
      "INSERT INTO conversations (id, user_id, title, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, userId, title, cleanCharId, now, now)
    .run();

  return {
    id,
    user_id: userId,
    title,
    character_id: cleanCharId,
    created_at: now,
    updated_at: now,
  };
}

export async function updateConversationMeta(db, userId, conversationId, title = null) {
  await ensureSchema(db);
  const now = Math.floor(Date.now() / 1000);
  if (title !== null) {
    await db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(title, now, conversationId, userId)
      .run();
  } else {
    await db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(now, conversationId, userId)
      .run();
  }
}

export async function deleteConversation(db, userId, conversationId) {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM messages WHERE user_id = ? AND conversation_id = ?")
    .bind(userId, conversationId)
    .run();
  await db
    .prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?")
    .bind(conversationId, userId)
    .run();
}

export async function listConversationMessages(db, userId, conversationId) {
  await ensureSchema(db);
  const res = await db
    .prepare(
      "SELECT id, msg_uid, conversation_id, role, content, image_data, created_at " +
        "FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY id ASC",
    )
    .bind(userId, conversationId)
    .all();

  return (res.results || []).map(mapMessageRow);
}

export async function getRecentMessages(db, userId, conversationId, limit) {
  await ensureSchema(db);
  const res = await db
    .prepare(
      "SELECT id, msg_uid, conversation_id, role, content, image_data, created_at " +
        "FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(userId, conversationId, limit)
    .all();

  const rows = res.results || [];
  rows.reverse();
  return rows;
}

export async function getLastMessage(db, userId, conversationId) {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT id, msg_uid, conversation_id, role, content, image_data, created_at " +
        "FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(userId, conversationId)
    .first();

  return row || null;
}

export async function insertMessage(db, { userId, conversationId, role, content, imageData }) {
  await ensureSchema(db);
  const msgUid = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);

  const info = await db
    .prepare(
      "INSERT INTO messages (user_id, conversation_id, msg_uid, role, content, image_data, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(userId, conversationId, msgUid, role, content || "", imageData || null, createdAt)
    .run();

  await updateConversationMeta(db, userId, conversationId, null);

  return {
    id: info.meta?.last_row_id ?? null,
    msg_uid: msgUid,
    conversation_id: conversationId,
    role,
    content: content || "",
    image_url: imageData || null,
    created_at: createdAt,
  };
}

export async function deleteMessageById(db, userId, id) {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM messages WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}

export async function getMessageById(db, userId, id) {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT id, msg_uid, conversation_id, role, content, image_data, created_at " +
        "FROM messages WHERE id = ? AND user_id = ?",
    )
    .bind(id, userId)
    .first();
  return row ? mapMessageRow(row) : null;
}

export async function updateMessageContent(db, userId, id, content) {
  await ensureSchema(db);
  await db
    .prepare("UPDATE messages SET content = ? WHERE id = ? AND user_id = ?")
    .bind(content, id, userId)
    .run();
  return getMessageById(db, userId, id);
}

export async function deleteMessagesFromId(db, userId, conversationId, fromId) {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM messages WHERE user_id = ? AND conversation_id = ? AND id >= ?")
    .bind(userId, conversationId, fromId)
    .run();
}

export async function clearUserConversationMessages(db, userId, conversationId) {
  await ensureSchema(db);
  if (conversationId) {
    await db
      .prepare("DELETE FROM messages WHERE user_id = ? AND conversation_id = ?")
      .bind(userId, conversationId)
      .run();
    await updateConversationMeta(db, userId, conversationId, "新对话");
  } else {
    await db.prepare("DELETE FROM messages WHERE user_id = ?").bind(userId).run();
    await db.prepare("DELETE FROM conversations WHERE user_id = ?").bind(userId).run();
  }
}

// ============================================================================
// 管理员动态配置（app_settings）与在线成员管理（managed_users）
// ============================================================================

export async function getAppSettingsMap(db) {
  await ensureSchema(db);
  const res = await db.prepare("SELECT key, value FROM app_settings").all();
  const map = {};
  for (const row of res.results || []) {
    map[row.key] = row.value;
  }
  return map;
}

export async function setAppSetting(db, key, value) {
  await ensureSchema(db);
  const now = Math.floor(Date.now() / 1000);
  if (value === null || value === undefined || value === "") {
    await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(key).run();
    return;
  }
  await db
    .prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, String(value), now)
    .run();
}

/**
 * 合并环境变量与 D1 管理员配置，产出实际生效的模型、接口地址与 API Key。
 */
export async function resolveRuntimeSettings(db, config) {
  const stored = db ? await getAppSettingsMap(db) : {};

  const modelName = String(stored.active_model || "").trim() || config.modelName;
  let provider = String(stored.active_provider || "").trim();
  if (!provider) {
    provider = modelName.toLowerCase().includes("deepseek") ? "deepseek" : "gemini";
  }

  const defaultBaseForProvider =
    provider === "deepseek" ? "https://api.deepseek.com/" : config.baseUrl;
  const baseUrl = normalizeBaseUrl(stored.active_base_url, defaultBaseForProvider);

  const geminiApiKey = String(stored.gemini_api_key || "").trim() || config.geminiApiKey;
  const deepseekApiKey = String(stored.deepseek_api_key || "").trim() || config.deepseekApiKey;
  const customApiKey = String(stored.custom_api_key || "").trim();

  let activeApiKey = geminiApiKey;
  if (provider === "deepseek") {
    activeApiKey = deepseekApiKey;
  } else if (provider === "custom") {
    activeApiKey = customApiKey || deepseekApiKey || geminiApiKey;
  }

  let reasoningEffort = config.reasoningEffort;
  if (Object.prototype.hasOwnProperty.call(stored, "reasoning_effort")) {
    const cleaned = String(stored.reasoning_effort || "").trim().toLowerCase();
    reasoningEffort = cleaned && cleaned !== "none" ? cleaned : null;
  }

  let fallbackModel =
    provider === "gemini" && modelName === "gemini-4-hydrogen"
      ? config.fallbackModel || DEFAULT_FALLBACK_MODEL
      : "";
  if (Object.prototype.hasOwnProperty.call(stored, "fallback_model")) {
    fallbackModel = String(stored.fallback_model || "").trim();
  }
  if (fallbackModel === modelName) fallbackModel = "";

  const systemPrompt = String(stored.system_prompt || "").trim() || DEFAULT_SYSTEM_PROMPT;

  return {
    provider,
    modelName,
    baseUrl,
    activeApiKey,
    geminiApiKey,
    deepseekApiKey,
    customApiKey,
    hasEnvGeminiKey: Boolean(config.geminiApiKey),
    hasEnvDeepseekKey: Boolean(config.deepseekApiKey),
    reasoningEffort,
    fallbackModel,
    systemPrompt,
  };
}

export async function listManagedUsers(db) {
  await ensureSchema(db);
  const res = await db
    .prepare("SELECT user_id, password, is_admin, updated_at FROM managed_users ORDER BY updated_at ASC")
    .all();
  return (res.results || []).map((r) => ({
    userId: r.user_id,
    password: r.password,
    isAdmin: Boolean(r.is_admin),
    source: "db",
  }));
}

export async function upsertManagedUser(db, { userId, password, isAdmin = false }) {
  await ensureSchema(db);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO managed_users (user_id, password, is_admin, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET password = excluded.password, is_admin = excluded.is_admin, updated_at = excluded.updated_at",
    )
    .bind(userId, password, isAdmin ? 1 : 0, now)
    .run();
}

export async function deleteManagedUser(db, userId) {
  await ensureSchema(db);
  await db.prepare("DELETE FROM managed_users WHERE user_id = ?").bind(userId).run();
}

export async function getUserMessageStats(db) {
  await ensureSchema(db);
  const res = await db
    .prepare("SELECT user_id, COUNT(*) AS msg_count FROM messages GROUP BY user_id")
    .all();
  const stats = {};
  for (const row of res.results || []) {
    stats[row.user_id] = Number(row.msg_count || 0);
  }
  return stats;
}

export async function getUserPersona(db, userId) {
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT system_prompt FROM user_preferences WHERE user_id = ?")
    .bind(userId)
    .first();
  return row && typeof row.system_prompt === "string" && row.system_prompt.trim()
    ? row.system_prompt.trim()
    : "";
}

export async function setUserPersona(db, userId, systemPrompt) {
  await ensureSchema(db);
  const cleaned = String(systemPrompt || "").trim();
  if (!cleaned) {
    await db.prepare("DELETE FROM user_preferences WHERE user_id = ?").bind(userId).run();
    return "";
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO user_preferences (user_id, system_prompt, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET system_prompt = excluded.system_prompt, updated_at = excluded.updated_at",
    )
    .bind(userId, cleaned, now)
    .run();
  return cleaned;
}

// ============================================================================
// 角色系统（characters）与长期记忆本（memories）及基础限流（rate_limits）
// ============================================================================

function mapCharacterRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    avatar: row.avatar || "✦",
    personality: row.personality || "",
    catchphrase: row.catchphrase || "",
    background: row.background || "",
    examples: row.examples || "",
    first_message: row.first_message || "",
    is_default: Boolean(row.is_default),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function seedDefaultCharactersIfEmpty(db, userId) {
  await ensureSchema(db);
  const existing = await db
    .prepare("SELECT id FROM characters WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();
  if (existing) return;

  const baseTs = Math.floor(Date.now() / 1000);
  for (let i = 0; i < DEFAULT_CHARACTER_PRESETS.length; i += 1) {
    const preset = DEFAULT_CHARACTER_PRESETS[i];
    const id = crypto.randomUUID();
    const ts = baseTs - i;
    await db
      .prepare(
        "INSERT INTO characters (id, user_id, name, avatar, personality, catchphrase, background, examples, first_message, is_default, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        userId,
        preset.name,
        preset.avatar,
        preset.personality,
        preset.catchphrase,
        preset.background,
        preset.examples,
        preset.first_message,
        preset.is_default ? 1 : 0,
        ts,
        ts,
      )
      .run();
  }
}

export async function listUserCharacters(db, userId, { autoSeed = true } = {}) {
  await ensureSchema(db);
  if (autoSeed) {
    await seedDefaultCharactersIfEmpty(db, userId);
  }
  const res = await db
    .prepare(
      "SELECT id, user_id, name, avatar, personality, catchphrase, background, examples, first_message, is_default, created_at, updated_at " +
        "FROM characters WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC",
    )
    .bind(userId)
    .all();
  return (res.results || []).map(mapCharacterRow);
}

export async function getCharacterById(db, userId, charId) {
  await ensureSchema(db);
  if (!charId) return null;
  const row = await db
    .prepare(
      "SELECT id, user_id, name, avatar, personality, catchphrase, background, examples, first_message, is_default, created_at, updated_at " +
        "FROM characters WHERE id = ? AND user_id = ?",
    )
    .bind(charId, userId)
    .first();
  return row ? mapCharacterRow(row) : null;
}

export async function getDefaultCharacter(db, userId) {
  await seedDefaultCharactersIfEmpty(db, userId);
  const row = await db
    .prepare(
      "SELECT id, user_id, name, avatar, personality, catchphrase, background, examples, first_message, is_default, created_at, updated_at " +
        "FROM characters WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC LIMIT 1",
    )
    .bind(userId)
    .first();
  return row ? mapCharacterRow(row) : null;
}

export async function createCharacter(db, userId, payload) {
  await ensureSchema(db);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const isDefault = Boolean(payload.is_default);
  if (isDefault) {
    await db.prepare("UPDATE characters SET is_default = 0 WHERE user_id = ?").bind(userId).run();
  }
  await db
    .prepare(
      "INSERT INTO characters (id, user_id, name, avatar, personality, catchphrase, background, examples, first_message, is_default, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      userId,
      String(payload.name || "").trim(),
      String(payload.avatar || "✦").trim() || "✦",
      String(payload.personality || "").trim(),
      String(payload.catchphrase || "").trim(),
      String(payload.background || "").trim(),
      String(payload.examples || "").trim(),
      String(payload.first_message || "").trim(),
      isDefault ? 1 : 0,
      now,
      now,
    )
    .run();
  return getCharacterById(db, userId, id);
}

export async function updateCharacter(db, userId, charId, payload) {
  await ensureSchema(db);
  const existing = await getCharacterById(db, userId, charId);
  if (!existing) return null;

  const nextDefault =
    Object.prototype.hasOwnProperty.call(payload, "is_default")
      ? Boolean(payload.is_default)
      : existing.is_default;
  if (nextDefault) {
    await db.prepare("UPDATE characters SET is_default = 0 WHERE user_id = ?").bind(userId).run();
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "UPDATE characters SET name = ?, avatar = ?, personality = ?, catchphrase = ?, background = ?, examples = ?, first_message = ?, is_default = ?, updated_at = ? " +
        "WHERE id = ? AND user_id = ?",
    )
    .bind(
      Object.prototype.hasOwnProperty.call(payload, "name") ? String(payload.name || "").trim() : existing.name,
      Object.prototype.hasOwnProperty.call(payload, "avatar") ? (String(payload.avatar || "").trim() || "✦") : existing.avatar,
      Object.prototype.hasOwnProperty.call(payload, "personality") ? String(payload.personality || "").trim() : existing.personality,
      Object.prototype.hasOwnProperty.call(payload, "catchphrase") ? String(payload.catchphrase || "").trim() : existing.catchphrase,
      Object.prototype.hasOwnProperty.call(payload, "background") ? String(payload.background || "").trim() : existing.background,
      Object.prototype.hasOwnProperty.call(payload, "examples") ? String(payload.examples || "").trim() : existing.examples,
      Object.prototype.hasOwnProperty.call(payload, "first_message") ? String(payload.first_message || "").trim() : existing.first_message,
      nextDefault ? 1 : 0,
      now,
      charId,
      userId,
    )
    .run();

  return getCharacterById(db, userId, charId);
}

export async function deleteCharacter(db, userId, charId) {
  await ensureSchema(db);
  await db
    .prepare("UPDATE conversations SET character_id = NULL WHERE user_id = ? AND character_id = ?")
    .bind(userId, charId)
    .run();
  await db
    .prepare("DELETE FROM memories WHERE user_id = ? AND character_id = ?")
    .bind(userId, charId)
    .run();
  await db
    .prepare("DELETE FROM characters WHERE id = ? AND user_id = ?")
    .bind(charId, userId)
    .run();
}

function mapMemoryRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    character_id: row.character_id || "",
    content: row.content || "",
    enabled: Boolean(row.enabled),
    source: row.source || "manual",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listUserMemories(db, userId, characterId = null) {
  await ensureSchema(db);
  const res =
    characterId === null
      ? await db
          .prepare(
            "SELECT id, user_id, character_id, content, enabled, source, created_at, updated_at " +
              "FROM memories WHERE user_id = ? ORDER BY id DESC",
          )
          .bind(userId)
          .all()
      : await db
          .prepare(
            "SELECT id, user_id, character_id, content, enabled, source, created_at, updated_at " +
              "FROM memories WHERE user_id = ? AND (character_id = '' OR character_id = ?) ORDER BY id DESC",
          )
          .bind(userId, characterId)
          .all();
  return (res.results || []).map(mapMemoryRow);
}

export async function getEnabledMemoriesForPrompt(db, userId, characterId = "") {
  await ensureSchema(db);
  const res = characterId
    ? await db
        .prepare(
          "SELECT id, user_id, character_id, content, enabled, source, created_at, updated_at " +
            "FROM memories WHERE user_id = ? AND enabled = 1 AND (character_id = '' OR character_id = ?) ORDER BY id DESC LIMIT 25",
        )
        .bind(userId, characterId)
        .all()
    : await db
        .prepare(
          "SELECT id, user_id, character_id, content, enabled, source, created_at, updated_at " +
            "FROM memories WHERE user_id = ? AND enabled = 1 AND character_id = '' ORDER BY id DESC LIMIT 25",
        )
        .bind(userId)
        .all();
  return (res.results || []).map(mapMemoryRow);
}

export async function createMemory(db, userId, { characterId = "", content, source = "manual" }) {
  await ensureSchema(db);
  const now = Math.floor(Date.now() / 1000);
  const cleanCharId = String(characterId || "").trim();
  const cleanContent = String(content || "").trim();
  const info = await db
    .prepare(
      "INSERT INTO memories (user_id, character_id, content, enabled, source, created_at, updated_at) " +
        "VALUES (?, ?, ?, 1, ?, ?, ?)",
    )
    .bind(userId, cleanCharId, cleanContent, source, now, now)
    .run();
  return {
    id: info.meta?.last_row_id ?? null,
    user_id: userId,
    character_id: cleanCharId,
    content: cleanContent,
    enabled: true,
    source,
    created_at: now,
    updated_at: now,
  };
}

export async function updateMemory(db, userId, id, { content, enabled, characterId }) {
  await ensureSchema(db);
  const existing = await db
    .prepare(
      "SELECT id, user_id, character_id, content, enabled, source, created_at, updated_at FROM memories WHERE id = ? AND user_id = ?",
    )
    .bind(id, userId)
    .first();
  if (!existing) return null;

  const now = Math.floor(Date.now() / 1000);
  const nextContent =
    content !== undefined ? String(content || "").trim() : existing.content;
  const nextEnabled =
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
  const nextCharId =
    characterId !== undefined ? String(characterId || "").trim() : existing.character_id;

  await db
    .prepare(
      "UPDATE memories SET content = ?, enabled = ?, character_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .bind(nextContent, nextEnabled, nextCharId, now, id, userId)
    .run();

  return mapMemoryRow({
    ...existing,
    content: nextContent,
    enabled: nextEnabled,
    character_id: nextCharId,
    updated_at: now,
  });
}

export async function deleteMemory(db, userId, id) {
  await ensureSchema(db);
  await db
    .prepare("DELETE FROM memories WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}

export async function checkRateLimit(db, bucketKey, maxRequests = 20, windowSeconds = 60) {
  if (!db) return { allowed: true, remaining: maxRequests, retryAfter: 0 };
  await ensureSchema(db);
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare("SELECT bucket_key, count, reset_at FROM rate_limits WHERE bucket_key = ?")
    .bind(bucketKey)
    .first();

  if (!existing || existing.reset_at <= now) {
    const nextReset = now + windowSeconds;
    await db
      .prepare(
        "INSERT INTO rate_limits (bucket_key, count, reset_at) VALUES (?, 1, ?) " +
          "ON CONFLICT(bucket_key) DO UPDATE SET count = 1, reset_at = excluded.reset_at",
      )
      .bind(bucketKey, nextReset)
      .run();
    return { allowed: true, remaining: Math.max(0, maxRequests - 1), retryAfter: 0 };
  }

  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, existing.reset_at - now),
    };
  }

  const nextCount = Number(existing.count || 0) + 1;
  await db
    .prepare("UPDATE rate_limits SET count = ? WHERE bucket_key = ?")
    .bind(nextCount, bucketKey)
    .run();

  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - nextCount),
    retryAfter: 0,
  };
}
