import { jsonResponse, requireAdminUser } from "../../_lib/auth.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  loadConfig,
  MAX_CONTEXT_TURNS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MIN_CONTEXT_TURNS,
  MIN_OUTPUT_TOKENS,
  MODEL_PRESETS,
  normalizeBaseUrl,
} from "../../_lib/config.js";
import { resolveRuntimeSettings, setAppSetting } from "../../_lib/db.js";

const MAX_SYSTEM_PROMPT_CHARS = 4000;

function maskSecret(key) {
  const val = String(key || "").trim();
  if (!val) return "";
  if (val.length <= 8) return "****";
  return `${val.slice(0, 4)}****${val.slice(-3)}`;
}

function serializeSettings(runtime) {
  return {
    provider: runtime.provider,
    model_name: runtime.modelName,
    base_url: runtime.baseUrl,
    fallback_model: runtime.fallbackModel,
    reasoning_effort: runtime.reasoningEffort === null ? "none" : runtime.reasoningEffort,
    system_prompt: runtime.systemPrompt,
    default_system_prompt: DEFAULT_SYSTEM_PROMPT,
    context_turns: runtime.contextTurns,
    max_output_tokens: runtime.maxOutputTokens,
    has_gemini_key: Boolean(runtime.geminiApiKey),
    gemini_key_masked: maskSecret(runtime.geminiApiKey),
    has_deepseek_key: Boolean(runtime.deepseekApiKey),
    deepseek_key_masked: maskSecret(runtime.deepseekApiKey),
    has_custom_key: Boolean(runtime.customApiKey),
    custom_key_masked: maskSecret(runtime.customApiKey),
  };
}

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  const auth = await requireAdminUser(request, config, env.DB);
  if (!auth.user) return jsonResponse({ detail: auth.detail }, auth.status);

  const runtime = await resolveRuntimeSettings(env.DB, config);
  return jsonResponse({
    presets: MODEL_PRESETS,
    settings: serializeSettings(runtime),
  });
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

  const hasPersonaUpdate = Object.prototype.hasOwnProperty.call(body, "system_prompt");
  const hasModelUpdate = Object.prototype.hasOwnProperty.call(body, "provider");
  const hasContextUpdate =
    Object.prototype.hasOwnProperty.call(body, "context_turns") ||
    Object.prototype.hasOwnProperty.call(body, "max_output_tokens");

  if (!hasPersonaUpdate && !hasModelUpdate && !hasContextUpdate) {
    return jsonResponse({ detail: "未包含任何可更新的配置项。" }, 400);
  }

  if (Object.prototype.hasOwnProperty.call(body, "context_turns")) {
    const turns = Number(body.context_turns);
    if (!Number.isInteger(turns) || turns < MIN_CONTEXT_TURNS || turns > MAX_CONTEXT_TURNS) {
      return jsonResponse(
        { detail: `上下文记忆轮数须为 ${MIN_CONTEXT_TURNS} 到 ${MAX_CONTEXT_TURNS} 之间的整数。` },
        400,
      );
    }
    await setAppSetting(env.DB, "context_turns", turns);
  }

  if (Object.prototype.hasOwnProperty.call(body, "max_output_tokens")) {
    const tokens = Number(body.max_output_tokens);
    if (
      !Number.isInteger(tokens) ||
      tokens < MIN_OUTPUT_TOKENS ||
      tokens > MAX_OUTPUT_TOKENS_LIMIT
    ) {
      return jsonResponse(
        {
          detail: `最大输出 Tokens 须为 ${MIN_OUTPUT_TOKENS} 到 ${MAX_OUTPUT_TOKENS_LIMIT} 之间的整数。`,
        },
        400,
      );
    }
    await setAppSetting(env.DB, "max_output_tokens", tokens);
  }

  if (hasPersonaUpdate) {
    const rawPersona = typeof body.system_prompt === "string" ? body.system_prompt.trim() : "";
    if (rawPersona.length > MAX_SYSTEM_PROMPT_CHARS) {
      return jsonResponse(
        { detail: `AI 人设不能超过 ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} 个字符。` },
        400,
      );
    }
    await setAppSetting(
      env.DB,
      "system_prompt",
      rawPersona && rawPersona !== DEFAULT_SYSTEM_PROMPT ? rawPersona : null,
    );
  }

  if (hasModelUpdate) {
    const provider = String(body.provider || "").trim().toLowerCase();
    if (!["gemini", "deepseek", "custom"].includes(provider)) {
      return jsonResponse({ detail: "不支持的模型提供方类型。" }, 400);
    }

    const modelName = String(body.model_name || "").trim();
    if (!modelName) {
      return jsonResponse({ detail: "模型 ID 不能为空。" }, 400);
    }

    const defaultBase =
      provider === "deepseek"
        ? "https://api.deepseek.com/"
        : "https://generativelanguage.googleapis.com/v1beta/openai/";
    const baseUrl = normalizeBaseUrl(body.base_url, defaultBase);
    if (!/^https?:\/\//i.test(baseUrl)) {
      return jsonResponse({ detail: "Base URL 必须以 http:// 或 https:// 开头。" }, 400);
    }

    const fallbackModel = String(body.fallback_model || "").trim();
    const effort = String(body.reasoning_effort || "low").trim().toLowerCase();

    await setAppSetting(env.DB, "active_provider", provider);
    await setAppSetting(env.DB, "active_model", modelName);
    await setAppSetting(env.DB, "active_base_url", baseUrl);
    await setAppSetting(env.DB, "fallback_model", fallbackModel);
    await setAppSetting(env.DB, "reasoning_effort", effort === "none" ? "none" : effort || "low");

    if (body.clear_gemini_key) {
      await setAppSetting(env.DB, "gemini_api_key", null);
    } else if (typeof body.gemini_api_key === "string" && body.gemini_api_key.trim()) {
      await setAppSetting(env.DB, "gemini_api_key", body.gemini_api_key.trim());
    }

    if (body.clear_deepseek_key) {
      await setAppSetting(env.DB, "deepseek_api_key", null);
    } else if (typeof body.deepseek_api_key === "string" && body.deepseek_api_key.trim()) {
      await setAppSetting(env.DB, "deepseek_api_key", body.deepseek_api_key.trim());
    }

    if (body.clear_custom_key) {
      await setAppSetting(env.DB, "custom_api_key", null);
    } else if (typeof body.custom_api_key === "string" && body.custom_api_key.trim()) {
      await setAppSetting(env.DB, "custom_api_key", body.custom_api_key.trim());
    }
  }

  const updated = await resolveRuntimeSettings(env.DB, config);
  return jsonResponse({
    ok: true,
    settings: serializeSettings(updated),
  });
}
