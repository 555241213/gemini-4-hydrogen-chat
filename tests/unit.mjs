import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, parseUserPasswords } from "../functions/_lib/config.js";
import {
  authenticatePassword,
  createSessionToken,
  getAllUserEntries,
  resolveSessionSecret,
  verifySessionToken,
} from "../functions/_lib/auth.js";
import { buildApiMessages, createChatSseResponse } from "../functions/_lib/sse.js";
import {
  clearUserConversationMessages,
  createConversation,
  deleteConversation,
  deleteMessagesFromId,
  insertMessage,
  listConversationMessages,
  listUserConversations,
  resolveRuntimeSettings,
  setAppSetting,
  setUserPersona,
  updateMessageContent,
  upsertManagedUser,
} from "../functions/_lib/db.js";

// 轻量 D1 内存模拟器，覆盖 conversations / messages / app_settings / managed_users
function createMockD1() {
  const conversations = [];
  const messages = [];
  const appSettings = new Map();
  const managedUsers = new Map();
  const userPreferences = new Map();
  let autoId = 1;

  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) {
          params = args;
          return stmt;
        },
        async run() {
          if (
            sql.startsWith("CREATE TABLE") ||
            sql.startsWith("CREATE INDEX") ||
            sql.startsWith("ALTER TABLE")
          ) {
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO conversations")) {
            const [id, user_id, title, created_at, updated_at] = params;
            conversations.push({ id, user_id, title, created_at, updated_at, rowid: conversations.length + 1 });
            return { success: true };
          }
          if (sql.startsWith("UPDATE conversations SET title = ?")) {
            const [title, updated_at, id, user_id] = params;
            const c = conversations.find((x) => x.id === id && x.user_id === user_id);
            if (c) {
              c.title = title;
              c.updated_at = updated_at;
            }
            return { success: true };
          }
          if (sql.startsWith("UPDATE conversations SET updated_at = ?")) {
            const [updated_at, id, user_id] = params;
            const c = conversations.find((x) => x.id === id && x.user_id === user_id);
            if (c) c.updated_at = updated_at;
            return { success: true };
          }
          if (sql.startsWith("UPDATE messages SET conversation_id = ?")) {
            const [convId, userId] = params;
            for (const m of messages) {
              if (m.user_id === userId && !m.conversation_id) m.conversation_id = convId;
            }
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO messages")) {
            const [user_id, conversation_id, msg_uid, role, content, image_data, created_at] = params;
            const id = autoId++;
            messages.push({ id, user_id, conversation_id, msg_uid, role, content, image_data, created_at });
            return { success: true, meta: { last_row_id: id } };
          }
          if (sql.startsWith("DELETE FROM messages WHERE id = ? AND user_id = ?")) {
            const [id, userId] = params;
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (messages[i].id === id && messages[i].user_id === userId) messages.splice(i, 1);
            }
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM messages WHERE user_id = ? AND conversation_id = ? AND id >= ?")) {
            const [userId, convId, fromId] = params;
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (messages[i].user_id === userId && messages[i].conversation_id === convId && messages[i].id >= fromId) {
                messages.splice(i, 1);
              }
            }
            return { success: true };
          }
          if (sql.startsWith("UPDATE messages SET content = ? WHERE id = ? AND user_id = ?")) {
            const [content, id, userId] = params;
            const m = messages.find((x) => x.id === id && x.user_id === userId);
            if (m) m.content = content;
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM messages WHERE user_id = ? AND conversation_id = ?")) {
            const [userId, convId] = params;
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (messages[i].user_id === userId && messages[i].conversation_id === convId) messages.splice(i, 1);
            }
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM messages WHERE user_id = ?")) {
            const [userId] = params;
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (messages[i].user_id === userId) messages.splice(i, 1);
            }
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM conversations WHERE id = ? AND user_id = ?")) {
            const [id, userId] = params;
            for (let i = conversations.length - 1; i >= 0; i -= 1) {
              if (conversations[i].id === id && conversations[i].user_id === userId) conversations.splice(i, 1);
            }
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM conversations WHERE user_id = ?")) {
            const [userId] = params;
            for (let i = conversations.length - 1; i >= 0; i -= 1) {
              if (conversations[i].user_id === userId) conversations.splice(i, 1);
            }
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO app_settings")) {
            const [key, value] = params;
            appSettings.set(key, value);
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM app_settings")) {
            appSettings.delete(params[0]);
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO managed_users")) {
            const [user_id, password, is_admin, updated_at] = params;
            managedUsers.set(user_id, { user_id, password, is_admin, updated_at });
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM managed_users")) {
            managedUsers.delete(params[0]);
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO user_preferences")) {
            const [user_id, system_prompt, updated_at] = params;
            userPreferences.set(user_id, { user_id, system_prompt, updated_at });
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM user_preferences")) {
            userPreferences.delete(params[0]);
            return { success: true };
          }
          throw new Error(`Unhandled SQL run: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM conversations WHERE user_id = ?")) {
            const [userId] = params;
            return {
              results: conversations
                .filter((c) => c.user_id === userId)
                .sort((a, b) => b.updated_at - a.updated_at || b.rowid - a.rowid),
            };
          }
          if (sql.includes("FROM messages") && sql.includes("ORDER BY id ASC")) {
            const [userId, convId] = params;
            return {
              results: messages
                .filter((m) => m.user_id === userId && m.conversation_id === convId)
                .sort((a, b) => a.id - b.id),
            };
          }
          if (sql.includes("FROM messages") && sql.includes("ORDER BY id DESC LIMIT ?")) {
            const [userId, convId, limit] = params;
            return {
              results: messages
                .filter((m) => m.user_id === userId && m.conversation_id === convId)
                .sort((a, b) => b.id - a.id)
                .slice(0, limit),
            };
          }
          if (sql.includes("FROM app_settings")) {
            return {
              results: Array.from(appSettings.entries()).map(([key, value]) => ({ key, value })),
            };
          }
          if (sql.includes("FROM managed_users")) {
            return {
              results: Array.from(managedUsers.values()),
            };
          }
          throw new Error(`Unhandled SQL all: ${sql}`);
        },
        async first() {
          if (sql.includes("FROM messages") && sql.includes("conversation_id IS NULL")) {
            const [userId] = params;
            const list = messages
              .filter((m) => m.user_id === userId && !m.conversation_id)
              .sort((a, b) => a.id - b.id);
            return list[0] || null;
          }
          if (sql.includes("FROM messages WHERE id = ? AND user_id = ?")) {
            const [id, userId] = params;
            return messages.find((m) => m.id === id && m.user_id === userId) || null;
          }
          if (sql.includes("FROM conversations WHERE id = ? AND user_id = ?")) {
            const [id, userId] = params;
            return conversations.find((c) => c.id === id && c.user_id === userId) || null;
          }
          if (sql.includes("FROM messages") && sql.includes("ORDER BY id DESC LIMIT 1")) {
            const [userId, convId] = params;
            const list = messages
              .filter((m) => m.user_id === userId && m.conversation_id === convId)
              .sort((a, b) => b.id - a.id);
            return list[0] || null;
          }
          if (sql.includes("FROM user_preferences WHERE user_id = ?")) {
            return userPreferences.get(params[0]) || null;
          }
          return null;
        },
      };
      return stmt;
    },
    _seedLegacyMessage(msg) {
      messages.push({ id: autoId++, ...msg });
    },
  };
}

test("parseUserPasswords supports JSON/delimiter pairs and marks admin username", () => {
  const fromJson = parseUserPasswords('{"admin":"adm123","小红":"p2"}');
  assert.equal(fromJson[0].isAdmin, true);
  assert.equal(fromJson[1].isAdmin, false);

  const fromLines = parseUserPasswords("小明:pass1\n管理员=pass2,阿强:pass3");
  assert.equal(fromLines.length, 3);
  assert.equal(fromLines[1].isAdmin, true);

  const twelve = Array.from({ length: 12 }, (_, i) => `u${i + 1}:pw${i + 1}`).join(",");
  assert.equal(parseUserPasswords(twelve).length, 10);
});

test("ADMIN_PASSWORD and online managed_users authentication with admin check", async () => {
  const db = createMockD1();
  const config = loadConfig({
    GEMINI_API_KEY: "k1",
    ADMIN_PASSWORD: "super_admin_pw",
    USER_PASSWORDS: "小红:pw_hong",
    DB: db,
  });

  await upsertManagedUser(db, { userId: "阿强", password: "pw_qiang", isAdmin: false });
  const allUsers = await getAllUserEntries(config, db);

  const adm = await authenticatePassword("super_admin_pw", allUsers);
  assert.equal(adm?.userId, "管理员");
  assert.equal(adm?.isAdmin, true);

  const friend = await authenticatePassword("pw_qiang", allUsers);
  assert.equal(friend?.userId, "阿强");
  assert.equal(friend?.isAdmin, false);

  const secret = await resolveSessionSecret(config);
  const admToken = await createSessionToken(adm.userId, adm.password, secret);
  const verified = await verifySessionToken(admToken, config, db);
  assert.deepEqual(verified, { userId: "管理员", isAdmin: true });
});

test("multi-conversation isolation and legacy message auto-migration", async () => {
  const db = createMockD1();
  db._seedLegacyMessage({
    user_id: "小红",
    conversation_id: null,
    msg_uid: "legacy-1",
    role: "user",
    content: "旧消息继续聊",
    image_data: null,
    created_at: 1000,
  });

  const convs = await listUserConversations(db, "小红");
  assert.equal(convs.length, 1);
  assert.equal(convs[0].title, "旧消息继续聊");
  const legacyMsgs = await listConversationMessages(db, "小红", convs[0].id);
  assert.equal(legacyMsgs.length, 1);

  const conv2 = await createConversation(db, "小红", "第二个话题");
  await insertMessage(db, {
    userId: "小红",
    conversationId: conv2.id,
    role: "user",
    content: "新话题内容",
  });
  assert.equal((await listConversationMessages(db, "小红", convs[0].id)).length, 1);
  assert.equal((await listConversationMessages(db, "小红", conv2.id)).length, 1);

  await clearUserConversationMessages(db, "小红", conv2.id);
  assert.equal((await listConversationMessages(db, "小红", conv2.id)).length, 0);
  await deleteConversation(db, "小红", conv2.id);
  assert.equal((await listUserConversations(db, "小红")).length, 1);
});

test("admin switching between DeepSeek V4.1 Flash and Gemini 4 persists in D1", async () => {
  const db = createMockD1();
  const config = loadConfig({
    GEMINI_API_KEY: "g_key",
    DEEPSEEK_API_KEY: "ds_key",
    USER_PASSWORDS: "admin:1234",
    DB: db,
  });

  const initial = await resolveRuntimeSettings(db, config);
  assert.equal(initial.provider, "gemini");
  assert.equal(initial.modelName, "gemini-4-hydrogen");
  assert.equal(initial.activeApiKey, "g_key");

  // 切换到 DeepSeek V4.1 Flash 并设定自定义 AI 人设
  await setAppSetting(db, "active_provider", "deepseek");
  await setAppSetting(db, "active_model", "deepseek-flash");
  await setAppSetting(db, "active_base_url", "https://api.deepseek.com/");
  await setAppSetting(db, "fallback_model", "");
  await setAppSetting(db, "system_prompt", "你是一只傲娇但很靠谱的电子小猫。");

  const dsRuntime = await resolveRuntimeSettings(db, config);
  assert.equal(dsRuntime.provider, "deepseek");
  assert.equal(dsRuntime.modelName, "deepseek-flash");
  assert.equal(dsRuntime.baseUrl, "https://api.deepseek.com/");
  assert.equal(dsRuntime.activeApiKey, "ds_key");
  assert.equal(dsRuntime.systemPrompt, "你是一只傲娇但很靠谱的电子小猫。");

  // 流式请求命中 DeepSeek 端点、模型与自定义人设
  const conv = await createConversation(db, "admin", "测试");
  await insertMessage(db, { userId: "admin", conversationId: conv.id, role: "user", content: "hi" });

  let requestedUrl = "";
  let requestedModel = "";
  let requestedSystem = "";
  const encoder = new TextEncoder();
  const res = createChatSseResponse({
    db,
    config,
    userId: "admin",
    conversationId: conv.id,
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      const body = JSON.parse(init.body);
      requestedModel = body.model;
      requestedSystem = body.messages[0]?.content || "";
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"DeepSeek回复"}}]}\n\n'));
            c.enqueue(encoder.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  const sseText = await res.text();
  assert.equal(requestedUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(requestedModel, "deepseek-flash");
  assert.equal(requestedSystem, "你是一只傲娇但很靠谱的电子小猫。");
  assert.match(sseText, /DeepSeek回复/);

  // 若用户自定义了个人人设，优先使用个人人设；清除后自动回退到管理员人设
  await setUserPersona(db, "admin", "我是用户专属的赛博管家。");
  const resUserPersona = createChatSseResponse({
    db,
    config,
    userId: "admin",
    conversationId: conv.id,
    fetchImpl: async (_, init) => {
      requestedSystem = JSON.parse(init.body).messages[0]?.content || "";
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
            c.enqueue(encoder.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  await resUserPersona.text();
  assert.equal(requestedSystem, "我是用户专属的赛博管家。");

  await setUserPersona(db, "admin", "");
  const resFallbackAdmin = createChatSseResponse({
    db,
    config,
    userId: "admin",
    conversationId: conv.id,
    fetchImpl: async (_, init) => {
      requestedSystem = JSON.parse(init.body).messages[0]?.content || "";
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
            c.enqueue(encoder.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  await resFallbackAdmin.text();
  assert.equal(requestedSystem, "你是一只傲娇但很靠谱的电子小猫。");

  // 503 多级备选模型链自动顺延回退（4-hydrogen -> 3.8-flash -> 3.6-flash）
  await setAppSetting(db, "active_provider", "gemini");
  await setAppSetting(db, "active_model", "gemini-4-hydrogen");
  await setAppSetting(db, "active_base_url", "https://gemini-us-relay-six.vercel.app/v1beta/openai/");
  await setAppSetting(db, "fallback_model", "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite");

  const chainModels = [];
  const resChain = createChatSseResponse({
    db,
    config,
    userId: "admin",
    conversationId: conv.id,
    fetchImpl: async (_, init) => {
      const m = JSON.parse(init.body).model;
      chainModels.push(m);
      if (m === "gemini-4-hydrogen" || m === "gemini-3.8-flash") {
        return new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 });
      }
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"3.6成功"}}]}\n\n'));
            c.enqueue(encoder.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  const chainText = await resChain.text();
  assert.match(chainText, /3\.6成功/);
  assert.deepEqual(chainModels, [
    "gemini-4-hydrogen",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
  ]);
});

test("buildApiMessages sliding window and single-turn image strategy", () => {
  const history = [
    { role: "user", content: "u1", image_data: "data:image/jpeg;base64,OLD1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "", image_data: "data:image/jpeg;base64,OLD2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3", image_data: "data:image/jpeg;base64,CURR3" },
  ];

  const msgs = buildApiMessages(history, 2, "System");
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].content, "[用户此前发了一张图片]");
  assert.equal(msgs[2].content, "a2");
  assert.ok(Array.isArray(msgs[3].content));
  assert.equal(msgs[3].content[1].image_url.url, "data:image/jpeg;base64,CURR3");
});

test("message edit and cascade rollback deleteMessagesFromId", async () => {
  const db = createMockD1();
  const conv = await createConversation(db, "alice", "回溯测试");
  const m1 = await insertMessage(db, { userId: "alice", conversationId: conv.id, role: "user", content: "第一句" });
  const m2 = await insertMessage(db, { userId: "alice", conversationId: conv.id, role: "assistant", content: "原始回复" });
  const m3 = await insertMessage(db, { userId: "alice", conversationId: conv.id, role: "user", content: "后续追问" });

  const edited = await updateMessageContent(db, "alice", m2.id, "修改后的回复");
  assert.equal(edited?.content, "修改后的回复");

  await deleteMessagesFromId(db, "alice", conv.id, m2.id);
  const left = await listConversationMessages(db, "alice", conv.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].id, m1.id);
  assert.notEqual(left[0].id, m3.id);
});
