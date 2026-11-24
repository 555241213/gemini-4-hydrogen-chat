/**
 * 一人一密认证、管理员识别与无状态 HMAC-SHA256 会话 Cookie 校验
 */

import { MAX_USERS, SESSION_TTL_SECONDS, isAdminUsername } from "./config.js";
import { listManagedUsers } from "./db.js";

export const SESSION_COOKIE_NAME = "xingmang_session";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function sha256Bytes(text) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  return new Uint8Array(digest);
}

async function sha256Hex(text) {
  const bytes = await sha256Bytes(text);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * 合并环境变量成员与 D1 在线管理成员（D1 同名条目可覆盖密码，管理员权限并集保持安全）。
 */
export async function getAllUserEntries(config, db) {
  const byId = new Map();
  for (const entry of config.userEntries) {
    byId.set(entry.userId, { ...entry });
  }
  if (db) {
    const dbUsers = await listManagedUsers(db);
    for (const u of dbUsers) {
      const existing = byId.get(u.userId);
      byId.set(u.userId, {
        userId: u.userId,
        password: u.password,
        isAdmin: Boolean(u.isAdmin || existing?.isAdmin || isAdminUsername(u.userId)),
        source: existing ? "env+db" : "db",
      });
    }
  }
  return Array.from(byId.values()).slice(0, MAX_USERS + 1);
}

/**
 * 若未显式配置 SESSION_SECRET，则基于后端稳定环境变量派生签名密钥。
 */
export async function resolveSessionSecret(config) {
  if (config.sessionSecret) return config.sessionSecret;
  return sha256Hex(
    `xingmang-session::${config.geminiApiKey}::${config.deepseekApiKey}::${config.adminPassword}::${config.rawUserPasswords}`,
  );
}

/**
 * 常量时间遍历所有成员密码进行认证。
 */
export async function authenticatePassword(candidate, userEntries) {
  if (!candidate || !userEntries.length) return null;
  const candidateDigest = await sha256Bytes(String(candidate));

  let matched = null;
  for (const entry of userEntries) {
    const expectedDigest = await sha256Bytes(entry.password);
    if (constantTimeEqualBytes(candidateDigest, expectedDigest) && !matched) {
      matched = entry;
    }
  }
  return matched;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionToken(userId, password, secret, ttlSeconds = SESSION_TTL_SECONDS) {
  const pv = (await sha256Hex(password)).slice(0, 12);
  const payload = {
    uid: userId,
    pv,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(payloadB64)));
  return `${payloadB64}.${toBase64Url(sig)}`;
}

export async function verifySessionToken(token, config, db = null) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const dotIdx = token.indexOf(".");
  const payloadB64 = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);
  if (!payloadB64 || !sigB64) return null;

  try {
    const secret = await resolveSessionSecret(config);
    const key = await importHmacKey(secret);
    const sigBytes = fromBase64Url(sigB64);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      textEncoder.encode(payloadB64),
    );
    if (!valid) return null;

    const payload = JSON.parse(textDecoder.decode(fromBase64Url(payloadB64)));
    if (!payload || !payload.uid || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    const allEntries = await getAllUserEntries(config, db);
    const entry = allEntries.find((u) => u.userId === payload.uid);
    if (!entry) return null;

    const currentPv = (await sha256Hex(entry.password)).slice(0, 12);
    if (payload.pv !== currentPv) return null;

    return {
      userId: entry.userId,
      isAdmin: Boolean(entry.isAdmin),
    };
  } catch {
    return null;
  }
}

export function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

export function buildSessionCookieHeader(token, request, maxAgeSeconds = SESSION_TTL_SECONDS) {
  const url = new URL(request.url);
  const isHttps = url.protocol === "https:";
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildLogoutCookieHeader(request) {
  return buildSessionCookieHeader("", request, 0);
}

export async function requireAuthenticatedUser(request, config, db = null) {
  const token = parseCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  return verifySessionToken(token, config, db);
}

export async function requireAdminUser(request, config, db = null) {
  const user = await requireAuthenticatedUser(request, config, db);
  if (!user) return { user: null, status: 401, detail: "未登录或登录已过期。" };
  if (!user.isAdmin) return { user: null, status: 403, detail: "仅管理员账户可访问后台设置。" };
  return { user, status: 200, detail: null };
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
