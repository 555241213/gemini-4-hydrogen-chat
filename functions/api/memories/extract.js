import { jsonResponse, requireAuthenticatedUser } from "../../_lib/auth.js";
import { loadConfig } from "../../_lib/config.js";
import {
  checkRateLimit,
  createMemory,
  getConversation,
  getRecentMessages,
  listUserMemories,
  resolveRuntimeSettings,
} from "../../_lib/db.js";
import { callModelWithFallback, formatUpstreamError } from "../../_lib/sse.js";

function parseExtractedFacts(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.facts)
        ? parsed.facts
        : [];
    return list
      .map((item) => String(item || "").trim())
      .filter((item) => item.length >= 2 && item.length <= 200);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) {
          return arr
            .map((item) => String(item || "").trim())
            .filter((item) => item.length >= 2 && item.length <= 200);
        }
      } catch {
        // 忽略 JSON 解析异常
      }
    }
    return [];
  }
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

  const limit = await checkRateLimit(env.DB, `extract:${user.userId}`, 10, 60);
  if (!limit.allowed) {
    return jsonResponse(
      { detail: `⏳ 记忆提炼过于频繁，请在 ${limit.retryAfter} 秒后再试。` },
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

  const conversationId = String(body.conversation_id || "").trim();
  const scopeCharacterId = String(body.character_id || "").trim();
  if (!conversationId) {
    return jsonResponse({ detail: "请先打开一条包含聊天内容的对话再提炼记忆。" }, 400);
  }

  const conv = await getConversation(env.DB, user.userId, conversationId);
  if (!conv) {
    return jsonResponse({ detail: "未找到该对话。" }, 404);
  }

  const recentRows = await getRecentMessages(env.DB, user.userId, conversationId, 16);
  const meaningfulRows = recentRows.filter(
    (r) => (r.role === "user" || r.role === "assistant") && String(r.content || "").trim(),
  );
  if (meaningfulRows.length < 2) {
    return jsonResponse({ added: [], detail: "当前对话内容还太少，暂时没有可提炼的长期记忆。" });
  }

  const runtime = await resolveRuntimeSettings(env.DB, config);
  if (!runtime.activeApiKey) {
    return jsonResponse({ detail: "当前模型尚未配置 API Key，无法自动提炼记忆。" }, 503);
  }

  const existingMemories = await listUserMemories(env.DB, user.userId, null);
  const existingSet = new Set(existingMemories.map((m) => m.content.trim().toLowerCase()));
  const existingSummary = existingMemories
    .slice(0, 20)
    .map((m) => `- ${m.content}`)
    .join("\n");

  const transcript = meaningfulRows
    .map((r) => `${r.role === "user" ? "用户" : "AI"}：${String(r.content).replace(/\|\|\|/g, " ")}`)
    .join("\n")
    .slice(0, 6000);

  const messages = [
    {
      role: "system",
      content:
        "你是一个记忆提炼助手。请从对话记录中提取关于用户的长期有效事实（例如姓名昵称、性格偏好、职业/宠物/生活习惯、重要日程或关系设定），忽略寒暄废话和一次性闲聊。\n" +
        "请只输出一个 JSON 字符串数组（例如 [\"用户养了一只叫年糕的橘猫\", \"用户平时不太能吃辣\"]），最多 5 条；若没有值得长期记住的新事实，请输出 []。",
    },
    {
      role: "user",
      content:
        (existingSummary ? `已有记忆（请勿重复提取）：\n${existingSummary}\n\n` : "") +
        `近期对话记录：\n${transcript}`,
    },
  ];

  const upstreamRes = await callModelWithFallback({
    runtime,
    messages,
    maxTokens: 512,
    stream: false,
  });

  if (!upstreamRes.ok) {
    const rawErr = await upstreamRes.text().catch(() => "");
    return jsonResponse({ detail: formatUpstreamError(upstreamRes.status, rawErr) }, 502);
  }

  const data = await upstreamRes.json().catch(() => ({}));
  const replyText = data?.choices?.[0]?.message?.content || "";
  const candidates = parseExtractedFacts(replyText);

  const added = [];
  for (const fact of candidates) {
    const norm = fact.toLowerCase();
    if (existingSet.has(norm)) continue;
    existingSet.add(norm);
    const created = await createMemory(env.DB, user.userId, {
      characterId: scopeCharacterId,
      content: fact,
      source: "auto",
    });
    added.push(created);
  }

  const memories = await listUserMemories(env.DB, user.userId, null);
  return jsonResponse({
    added,
    memories,
    detail: added.length ? `已新提炼 ${added.length} 条长期记忆` : "没有发现新的长期记忆要点",
  });
}
