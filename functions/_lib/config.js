/**
 * 运行配置读取与常量定义（全部来自 Cloudflare Pages 环境变量 / Secrets）
 */

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
export const DEFAULT_MODEL_NAME = "gemini-4-hydrogen";
export const DEFAULT_REASONING_EFFORT = "low";

export const DEFAULT_SYSTEM_PROMPT =
  "你是一位亲切、自然、乐于助人的日常 AI 助手。" +
  "请用通俗清晰、友好自然的中文回答用户的日常聊天、生活建议、文字润色和图片识别问题。";

export const MAX_INPUT_CHARS = 12000;
export const MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_CONTEXT_TURNS = 6;
export const API_TIMEOUT_MS = 60000;
export const MAX_IMAGE_DATA_URL_LEN = 900000;
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
export const MAX_USERS = 10;

/**
 * 解析「一人一密」配置：
 * 支持以下两种格式，方便在 Cloudflare 后台直接填写：
 * 1) JSON 对象：{"小明":"pass1","小红":"pass2"}
 * 2) 逗号或换行分隔的键值对：小明:pass1,小红:pass2 或 小明=pass1
 */
export function parseUserPasswords(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return [];

  const entries = [];
  const seenUsers = new Set();

  const pushEntry = (userId, password) => {
    const uid = String(userId || "").trim();
    const pwd = String(password || "").trim();
    if (!uid || !pwd || seenUsers.has(uid)) return;
    seenUsers.add(uid);
    entries.push({ userId: uid, password: pwd });
  };

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [uid, pwd] of Object.entries(parsed)) {
          pushEntry(uid, pwd);
        }
        return entries.slice(0, MAX_USERS);
      }
    } catch {
      // JSON 解析失败时回退按分隔符解析
    }
  }

  const parts = raw.split(/[\r\n,;]+/);
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    const eqIdx = line.indexOf("=");
    let sepIdx = -1;
    if (colonIdx > 0 && eqIdx > 0) {
      sepIdx = Math.min(colonIdx, eqIdx);
    } else {
      sepIdx = Math.max(colonIdx, eqIdx);
    }
    if (sepIdx <= 0) continue;
    pushEntry(line.slice(0, sepIdx), line.slice(sepIdx + 1));
  }

  return entries.slice(0, MAX_USERS);
}

/**
 * 从 Cloudflare env 读取并校验运行配置。
 */
export function loadConfig(env = {}) {
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  const rawUserPasswords = String(env.USER_PASSWORDS || "").trim();
  const userEntries = parseUserPasswords(rawUserPasswords);
  const baseUrlRaw = String(env.BASE_URL || "").trim() || DEFAULT_BASE_URL;
  const baseUrl = baseUrlRaw.endsWith("/") ? baseUrlRaw : `${baseUrlRaw}/`;
  const modelName = String(env.MODEL_NAME || "").trim() || DEFAULT_MODEL_NAME;
  const sessionSecret = String(env.SESSION_SECRET || "").trim();

  // 思考深度控制：未配置默认 "low"；显式置空或误配 "none" 时请求不传该参数
  let reasoningEffort = DEFAULT_REASONING_EFFORT;
  if (Object.prototype.hasOwnProperty.call(env, "REASONING_EFFORT") && env.REASONING_EFFORT !== undefined) {
    const cleaned = String(env.REASONING_EFFORT).trim().toLowerCase();
    reasoningEffort = cleaned && cleaned !== "none" ? cleaned : null;
  }

  const missing = [];
  if (!apiKey) missing.push("GEMINI_API_KEY");
  if (!userEntries.length) missing.push("USER_PASSWORDS");
  if (!env.DB) missing.push("D1 数据库绑定（变量名 DB）");

  return {
    apiKey,
    rawUserPasswords,
    userEntries,
    baseUrl,
    modelName,
    reasoningEffort,
    sessionSecret,
    hasDb: Boolean(env.DB),
    configured: missing.length === 0,
    missing,
  };
}
