import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, parseUserPasswords } from "../functions/_lib/config.js";
import {
  authenticatePassword,
  createSessionToken,
  resolveSessionSecret,
  verifySessionToken,
} from "../functions/_lib/auth.js";
import { buildApiMessages, createChatSseResponse } from "../functions/_lib/sse.js";
import { listUserMessages, clearUserMessages, insertMessage } from "../functions/_lib/db.js";

// 轻量 D1 内存模拟器，覆盖隔离查询、插入、删除与清空
function createMockD1() {
  const rows = [];
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
          if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE INDEX")) {
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO messages")) {
            const [user_id, msg_uid, role, content, image_data, created_at] = params;
            const id = autoId++;
            rows.push({ id, user_id, msg_uid, role, content, image_data, created_at });
            return { success: true, meta: { last_row_id: id } };
          }
          if (sql.startsWith("DELETE FROM messages WHERE id = ? AND user_id = ?")) {
            const [id, userId] = params;
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (rows[i].id === id && rows[i].user_id === userId) rows.splice(i, 1);
            }
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM messages WHERE user_id = ?")) {
            const [userId] = params;
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (rows[i].user_id === userId) rows.splice(i, 1);
            }
            return { success: true };
          }
          throw new Error(`Unhandled SQL run: ${sql}`);
        },
        async all() {
          if (sql.includes("ORDER BY id ASC")) {
            const [userId] = params;
            return { results: rows.filter((r) => r.user_id === userId).sort((a, b) => a.id - b.id) };
          }
          if (sql.includes("ORDER BY id DESC LIMIT ?")) {
            const [userId, limit] = params;
            return {
              results: rows
                .filter((r) => r.user_id === userId)
                .sort((a, b) => b.id - a.id)
                .slice(0, limit),
            };
          }
          throw new Error(`Unhandled SQL all: ${sql}`);
        },
        async first() {
          const [userId] = params;
          const filtered = rows.filter((r) => r.user_id === userId).sort((a, b) => b.id - a.id);
          return filtered[0] || null;
        },
      };
      return stmt;
    },
  };
}

test("parseUserPasswords supports JSON and delimiter pairs with 10-user cap", () => {
  const fromJson = parseUserPasswords('{"小明":"p1","小红":"p2"}');
  assert.deepEqual(fromJson, [
    { userId: "小明", password: "p1" },
    { userId: "小红", password: "p2" },
  ]);

  const fromLines = parseUserPasswords("小明:pass1\n小红=pass2,阿强:pass3");
  assert.equal(fromLines.length, 3);
  assert.equal(fromLines[2].userId, "阿强");
  assert.equal(fromLines[2].password, "pass3");

  const twelve = Array.from({ length: 12 }, (_, i) => `u${i + 1}:pw${i + 1}`).join(",");
  assert.equal(parseUserPasswords(twelve).length, 10);
});

test("loadConfig defaults and REASONING_EFFORT handling", () => {
  const mockDb = createMockD1();
  const cfg = loadConfig({
    GEMINI_API_KEY: "test-key",
    USER_PASSWORDS: "alice:123456",
    DB: mockDb,
  });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.modelName, "gemini-4-hydrogen");
  assert.equal(cfg.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
  assert.equal(cfg.reasoningEffort, "low");

  const emptyEffort = loadConfig({
    GEMINI_API_KEY: "test-key",
    USER_PASSWORDS: "alice:123456",
    REASONING_EFFORT: "",
    DB: mockDb,
  });
  assert.equal(emptyEffort.reasoningEffort, null);

  const noneEffort = loadConfig({
    GEMINI_API_KEY: "test-key",
    USER_PASSWORDS: "alice:123456",
    REASONING_EFFORT: "none",
    DB: mockDb,
  });
  assert.equal(noneEffort.reasoningEffort, null);
});

test("per-user authentication, session signing, and password rotation invalidation", async () => {
  const mockDb = createMockD1();
  const config = loadConfig({
    GEMINI_API_KEY: "k1",
    USER_PASSWORDS: "小明:pw_ming,小红:pw_hong",
    DB: mockDb,
  });

  const matched = await authenticatePassword("pw_hong", config.userEntries);
  assert.equal(matched?.userId, "小红");
  assert.equal(await authenticatePassword("wrong", config.userEntries), null);

  const secret = await resolveSessionSecret(config);
  const token = await createSessionToken(matched.userId, matched.password, secret);
  const verified = await verifySessionToken(token, config);
  assert.deepEqual(verified, { userId: "小红" });

  // 修改密码后旧 Token 自动失效
  const rotatedConfig = loadConfig({
    GEMINI_API_KEY: "k1",
    USER_PASSWORDS: "小明:pw_ming,小红:pw_hong_new",
    DB: mockDb,
  });
  assert.equal(await verifySessionToken(token, rotatedConfig), null);
});

test("buildApiMessages sliding window & single-turn image strategy", () => {
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

test("D1 isolation and SSE streaming persistence on success vs error", async () => {
  const db = createMockD1();
  const config = loadConfig({
    GEMINI_API_KEY: "k1",
    USER_PASSWORDS: "小明:p1,小红:p2",
    DB: db,
  });

  await insertMessage(db, { userId: "小红", role: "user", content: "小红的私密消息" });
  const savedMing = await insertMessage(db, { userId: "小明", role: "user", content: "你好" });

  const encoder = new TextEncoder();
  const okFetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'));
          c.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"呀！"}}]}\n\n'));
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    );

  const sseRes = createChatSseResponse({
    db,
    config,
    userId: "小明",
    preSavedUserMsg: savedMing,
    fetchImpl: okFetch,
  });
  const sseText = await sseRes.text();
  assert.match(sseText, /event: user_saved/);
  assert.match(sseText, /event: delta/);
  assert.match(sseText, /event: done/);

  const mingMsgs = await listUserMessages(db, "小明");
  const hongMsgs = await listUserMessages(db, "小红");
  assert.equal(mingMsgs.length, 2);
  assert.equal(mingMsgs[1].content, "你好呀！");
  assert.equal(hongMsgs.length, 1);
  assert.equal(hongMsgs[0].content, "小红的私密消息");

  // 异常时不写入残缺助手回复
  const errFetch = async () => new Response("rate limit", { status: 429 });
  const errRes = createChatSseResponse({ db, config, userId: "小明", fetchImpl: errFetch });
  const errText = await errRes.text();
  assert.match(errText, /event: error/);
  assert.equal((await listUserMessages(db, "小明")).length, 2);

  // 503 高峰期自动重试并回退到 gemini-3.8-flash
  const calledModels = [];
  const fallbackFetch = async (_, init) => {
    const body = JSON.parse(init.body);
    calledModels.push(body.model);
    if (body.model === "gemini-4-hydrogen") {
      return new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 });
    }
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"备选回复"}}]}\n\n'));
          c.enqueue(encoder.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    );
  };
  const fbRes = createChatSseResponse({ db, config, userId: "小明", fetchImpl: fallbackFetch });
  const fbText = await fbRes.text();
  assert.match(fbText, /event: done/);
  assert.deepEqual(calledModels, ["gemini-4-hydrogen", "gemini-4-hydrogen", "gemini-3.8-flash"]);
  assert.equal((await listUserMessages(db, "小明")).length, 3);

  await clearUserMessages(db, "小明");
  assert.equal((await listUserMessages(db, "小明")).length, 0);
  assert.equal((await listUserMessages(db, "小红")).length, 1);
});
