/**
 * 运行配置读取、模型预设定义与常量配置（环境变量 + D1 动态覆盖）
 */

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/";
export const DEFAULT_ALIYUN_MAAS_BASE_URL = "https://maas.qianwenaiapi.com/compatible-mode/v1/";

export const DEFAULT_BASE_URL = DEFAULT_GEMINI_BASE_URL;
export const DEFAULT_MODEL_NAME = "gemini-4-hydrogen";
export const DEFAULT_FALLBACK_MODEL = "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite";
export const DEFAULT_REASONING_EFFORT = "low";

export const DEFAULT_SYSTEM_PROMPT =
  "你是一位亲切、自然、乐于助人的日常 AI 助手。" +
  "请用通俗清晰、友好自然的中文回答用户的日常聊天、生活建议、文字润色和图片识别问题。" +
  "请根据用户输入的内容与问题复杂度自行决定回复篇幅：日常寒暄或简单问题简明直答，不要刻意拉长；当问题较复杂、需要分步说明或用户要求详细展开时，再输出完整详尽的内容。";

export const MAX_INPUT_CHARS = 12000;
export const MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_CONTEXT_TURNS = 6;
export const API_TIMEOUT_MS = 60000;
export const MAX_IMAGE_DATA_URL_LEN = 900000;
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
export const MAX_USERS = 10;

// 管理员后台内置模型预设（支持 DeepSeek V4.1 Flash 与 Gemini 4 全系快速切换）
export const MODEL_PRESETS = [
  {
    id: "gemini-4-hydrogen-us-relay",
    label: "Gemini 4 Hydrogen（美东转发）",
    provider: "gemini",
    modelName: "gemini-4-hydrogen",
    baseUrl: "https://gemini-us-relay-six.vercel.app/v1beta/openai/",
    defaultEffort: "low",
    desc: "经 Vercel 美东（iad1）转发 Google 官方，国内免代理不撞香港限制",
  },
  {
    id: "aliyun-deepseek-v4.1-flash",
    label: "阿里云 DeepSeek V4.1 Flash",
    provider: "deepseek",
    modelName: "deepseek-v4.1-flash",
    baseUrl: DEFAULT_ALIYUN_MAAS_BASE_URL,
    defaultEffort: "none",
    desc: "阿里云千问平台 MaaS 兼容接口（可按控制台实际模型 ID 微调）",
  },
  {
    id: "deepseek-v4.1-flash",
    label: "DeepSeek 官方 V4.1 Flash",
    provider: "deepseek",
    modelName: "deepseek-flash",
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    defaultEffort: "low",
    desc: "DeepSeek 官方接口（api.deepseek.com，原生支持图文）",
  },
  {
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    provider: "gemini",
    modelName: "gemini-4-hydrogen",
    baseUrl: DEFAULT_GEMINI_BASE_URL,
    desc: "Google Gemini 4 轻量主力模型（支持免费/付费额度与多模态识图）",
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    provider: "gemini",
    modelName: "gemini-4-argon",
    baseUrl: DEFAULT_GEMINI_BASE_URL,
    desc: "Google Gemini 4 高效推理模型（需付费层级 API Key）",
  },
  {
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    provider: "gemini",
    modelName: "gemini-4-neon",
    baseUrl: DEFAULT_GEMINI_BASE_URL,
    desc: "Google Gemini 4 旗舰高速模型（需付费层级 API Key）",
  },
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "gemini",
    modelName: "gemini-3.8-flash",
    baseUrl: DEFAULT_GEMINI_BASE_URL,
    desc: "Google Gemini 3.8 稳定 Flash 模型（高并发时最稳备选）",
  },
];

export function isAdminUsername(userId) {
  const lower = String(userId || "").trim().toLowerCase();
  return lower === "admin" || lower === "管理员";
}

/**
 * 解析「一人一密」配置：
 * 支持 JSON 对象或逗号/换行分隔的 昵称:密码 / 昵称=密码
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
    entries.push({
      userId: uid,
      password: pwd,
      isAdmin: isAdminUsername(uid),
      source: "env",
    });
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
      // 回退分隔符解析
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

export function normalizeBaseUrl(rawUrl, fallbackUrl = DEFAULT_GEMINI_BASE_URL) {
  const cleaned = String(rawUrl || "").trim() || fallbackUrl;
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

/**
 * 从 Cloudflare env 读取基础配置。
 */
export function loadConfig(env = {}) {
  const geminiApiKey = String(env.GEMINI_API_KEY || "").trim();
  const deepseekApiKey = String(env.DEEPSEEK_API_KEY || "").trim();
  const adminPassword = String(env.ADMIN_PASSWORD || "").trim();
  const rawUserPasswords = String(env.USER_PASSWORDS || "").trim();

  const envEntries = parseUserPasswords(rawUserPasswords);
  const userEntries = [];
  if (adminPassword) {
    userEntries.push({
      userId: "管理员",
      password: adminPassword,
      isAdmin: true,
      source: "env_admin",
    });
  }
  for (const entry of envEntries) {
    if (entry.userId === "管理员" && adminPassword) continue;
    userEntries.push(entry);
  }

  const baseUrl = normalizeBaseUrl(env.BASE_URL, DEFAULT_BASE_URL);
  const modelName = String(env.MODEL_NAME || "").trim() || DEFAULT_MODEL_NAME;
  const sessionSecret = String(env.SESSION_SECRET || "").trim();

  let reasoningEffort = DEFAULT_REASONING_EFFORT;
  if (Object.prototype.hasOwnProperty.call(env, "REASONING_EFFORT") && env.REASONING_EFFORT !== undefined) {
    const cleaned = String(env.REASONING_EFFORT).trim().toLowerCase();
    reasoningEffort = cleaned && cleaned !== "none" ? cleaned : null;
  }

  let fallbackModel = modelName === DEFAULT_MODEL_NAME ? DEFAULT_FALLBACK_MODEL : "";
  if (Object.prototype.hasOwnProperty.call(env, "FALLBACK_MODEL") && env.FALLBACK_MODEL !== undefined) {
    fallbackModel = String(env.FALLBACK_MODEL).trim();
  }
  if (fallbackModel === modelName) {
    fallbackModel = "";
  }

  const missing = [];
  if (!geminiApiKey && !deepseekApiKey) missing.push("GEMINI_API_KEY 或 DEEPSEEK_API_KEY");
  if (!userEntries.length) missing.push("USER_PASSWORDS 或 ADMIN_PASSWORD");
  if (!env.DB) missing.push("D1 数据库绑定（变量名 DB）");

  return {
    apiKey: geminiApiKey,
    geminiApiKey,
    deepseekApiKey,
    adminPassword,
    rawUserPasswords,
    userEntries,
    baseUrl,
    modelName,
    fallbackModel,
    reasoningEffort,
    sessionSecret,
    hasDb: Boolean(env.DB),
    configured: missing.length === 0,
    missing,
  };
}
