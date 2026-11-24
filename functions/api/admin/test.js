import { jsonResponse, requireAdminUser } from "../../_lib/auth.js";
import { loadConfig, normalizeBaseUrl } from "../../_lib/config.js";
import { resolveRuntimeSettings } from "../../_lib/db.js";
import { extractSafeUpstreamDetail } from "../../_lib/sse.js";

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  const auth = await requireAdminUser(request, config, env.DB);
  if (!auth.user) return jsonResponse({ detail: auth.detail }, auth.status);

  let body = {};
  try {
    body = await request.json();
  } catch {
    // 允许空请求体直接测试当前生效配置
  }

  const runtime = await resolveRuntimeSettings(env.DB, config);
  const provider = String(body.provider || runtime.provider).trim().toLowerCase();
  const modelName = String(body.model_name || runtime.modelName).trim();
  const baseUrl = normalizeBaseUrl(
    body.base_url || runtime.baseUrl,
    provider === "deepseek"
      ? "https://api.deepseek.com/"
      : "https://generativelanguage.googleapis.com/v1beta/openai/",
  );

  let apiKey = "";
  if (provider === "deepseek") {
    apiKey = String(body.deepseek_api_key || "").trim() || runtime.deepseekApiKey;
  } else if (provider === "custom") {
    apiKey =
      String(body.custom_api_key || "").trim() ||
      runtime.customApiKey ||
      runtime.deepseekApiKey ||
      runtime.geminiApiKey;
  } else {
    apiKey = String(body.gemini_api_key || "").trim() || runtime.geminiApiKey;
  }

  if (!apiKey) {
    return jsonResponse({ ok: false, detail: `尚未填写 ${provider} 对应的 API Key。` }, 400);
  }

  const payload = {
    model: modelName,
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 16,
    stream: false,
  };
  const effort = String(
    body.reasoning_effort !== undefined
      ? body.reasoning_effort
      : runtime.reasoningEffort || "low",
  )
    .trim()
    .toLowerCase();
  if (effort && effort !== "none") {
    payload.reasoning_effort = effort;
  }

  const startMs = Date.now();
  try {
    const res = await fetch(`${baseUrl}chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });

    const elapsedMs = Date.now() - startMs;
    if (!res.ok) {
      const rawErr = await res.text().catch(() => "");
      const detail = extractSafeUpstreamDetail(rawErr);
      return jsonResponse({
        ok: false,
        status: res.status,
        elapsed_ms: elapsedMs,
        detail: `HTTP ${res.status}${detail ? `：${detail}` : ""}`,
      });
    }

    return jsonResponse({
      ok: true,
      elapsed_ms: elapsedMs,
      detail: `连通成功（模型 ${modelName} 正常响应，耗时 ${elapsedMs}ms）`,
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      detail: `连接失败：${err?.name === "TimeoutError" ? "请求超时（20s）" : "网络异常或地址不可达"}`,
    });
  }
}
