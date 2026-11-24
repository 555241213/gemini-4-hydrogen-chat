import { jsonResponse } from "../_lib/auth.js";
import { loadConfig } from "../_lib/config.js";

export async function onRequestGet({ env }) {
  const config = loadConfig(env);
  return jsonResponse({
    configured: config.configured,
    missing: config.missing,
  });
}
