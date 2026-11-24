/**
 * Cloudflare D1 云端聊天记录存储层（按 user_id 严格隔离，首次访问自动建表）
 */

let schemaInitPromise = null;

export async function ensureSchema(db) {
  if (!db) {
    throw new Error("未检测到 D1 数据库绑定（DB）。");
  }
  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      await db
        .prepare(
          "CREATE TABLE IF NOT EXISTS messages (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "user_id TEXT NOT NULL, " +
            "msg_uid TEXT NOT NULL, " +
            "role TEXT NOT NULL, " +
            "content TEXT NOT NULL DEFAULT '', " +
            "image_data TEXT, " +
            "created_at INTEGER NOT NULL" +
          ")",
        )
        .run();

      await db
        .prepare("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages (user_id, id)")
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
    role: row.role,
    content: row.content || "",
    image_url: row.image_data || null,
    created_at: row.created_at,
  };
}

export async function listUserMessages(db, userId) {
  await ensureSchema(db);
  const res = await db
    .prepare(
      "SELECT id, msg_uid, role, content, image_data, created_at " +
        "FROM messages WHERE user_id = ? ORDER BY id ASC",
    )
    .bind(userId)
    .all();

  return (res.results || []).map(mapMessageRow);
}

export async function getRecentMessages(db, userId, limit) {
  await ensureSchema(db);
  const res = await db
    .prepare(
      "SELECT id, msg_uid, role, content, image_data, created_at " +
        "FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(userId, limit)
    .all();

  const rows = res.results || [];
  rows.reverse();
  return rows;
}

export async function getLastMessage(db, userId) {
  await ensureSchema(db);
  const row = await db
    .prepare(
      "SELECT id, msg_uid, role, content, image_data, created_at " +
        "FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(userId)
    .first();

  return row || null;
}

export async function insertMessage(db, { userId, role, content, imageData }) {
  await ensureSchema(db);
  const msgUid = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);

  const info = await db
    .prepare(
      "INSERT INTO messages (user_id, msg_uid, role, content, image_data, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(userId, msgUid, role, content || "", imageData || null, createdAt)
    .run();

  return {
    id: info.meta?.last_row_id ?? null,
    msg_uid: msgUid,
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

export async function clearUserMessages(db, userId) {
  await ensureSchema(db);
  await db.prepare("DELETE FROM messages WHERE user_id = ?").bind(userId).run();
}
