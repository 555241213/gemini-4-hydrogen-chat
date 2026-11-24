import { jsonResponse } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";
import { listManagedUsers, resolveRuntimeSettings } from "../_lib/db.js";

export async function onRequestGet({ env }) {
  const config = loadConfig(env);
  const missing = [];

  if (!config.hasDb) {
    missing.push("D1 数据库绑定（变量名 DB）");
    return jsonResponse({ configured: false, missing });
  }

  const runtime = await resolveRuntimeSettings(env.DB, config);
  const dbUsers = await listManagedUsers(env.DB);
  const hasUsers = config.userEntries.length > 0 || dbUsers.length > 0;
  const hasAnyKey = Boolean(runtime.geminiApiKey || runtime.deepseekApiKey || runtime.customApiKey);

  if (!hasAnyKey) missing.push("GEMINI_API_KEY 或 DEEPSEEK_API_KEY");
  if (!hasUsers) missing.push("USER_PASSWORDS 或 ADMIN_PASSWORD");

  return jsonResponse({
    configured: missing.length === 0,
    missing,
  });
}
