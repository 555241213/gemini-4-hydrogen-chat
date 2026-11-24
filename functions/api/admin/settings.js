import { jsonResponse, requireAdminUser } from "../../_lib/auth.js";
import { loadConfig, MODEL_PRESETS, normalizeBaseUrl } from "../../_lib/config.js";
import { resolveRuntimeSettings, setAppSetting } from "../../_lib/db.js";

function maskSecret(key) {
  const val = String(key || "").trim();
  if (!val) return "";
  if (val.length <= 8) return "****";
  return `${val.slice(0, 4)}****${val.slice(-3)}`;
}

export async function onRequestGet({ request, env }) {
  const config = loadConfig(env);
  const auth = await requireAdminUser(request, config, env.DB);
  if (!auth.user) return jsonResponse({ detail: auth.detail }, auth.status);

  const runtime = await resolveRuntimeSettings(env.DB, config);
  return jsonResponse({
    presets: MODEL_PRESETS,
    settings: {
      provider: runtime.provider,
      model_name: runtime.modelName,
      base_url: runtime.baseUrl,
      fallback_model: runtime.fallbackModel,
      reasoning_effort: runtime.reasoningEffort === null ? "none" : runtime.reasoningEffort,
      has_gemini_key: Boolean(runtime.geminiApiKey),
      gemini_key_masked: maskSecret(runtime.geminiApiKey),
      has_deepseek_key: Boolean(runtime.deepseekApiKey),
      deepseek_key_masked: maskSecret(runtime.deepseekApiKey),
      has_custom_key: Boolean(runtime.customApiKey),
      custom_key_masked: maskSecret(runtime.customApiKey),
    },
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

  // 仅当管理员显式填写新 Key 或请求清除时才更新，留空保持原配置不变
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

  const updated = await resolveRuntimeSettings(env.DB, config);
  return jsonResponse({
    ok: true,
    settings: {
      provider: updated.provider,
      model_name: updated.modelName,
      base_url: updated.baseUrl,
      fallback_model: updated.fallbackModel,
      reasoning_effort: updated.reasoningEffort === null ? "none" : updated.reasoningEffort,
      has_gemini_key: Boolean(updated.geminiApiKey),
      gemini_key_masked: maskSecret(updated.geminiApiKey),
      has_deepseek_key: Boolean(updated.deepseekApiKey),
      deepseek_key_masked: maskSecret(updated.deepseekApiKey),
      has_custom_key: Boolean(updated.customApiKey),
      custom_key_masked: maskSecret(updated.customApiKey),
    },
  });
}
