/**
 * 一人一密认证与无状态 HMAC-SHA256 会话 Cookie 校验（基于 Web Crypto API）
 */

import { SESSION_TTL_SECONDS } from "./config.js";

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
 * 若未显式配置 SESSION_SECRET，则基于后端密钥派生稳定的签名密钥，减少配置步骤。
 */
export async function resolveSessionSecret(config) {
  if (config.sessionSecret) return config.sessionSecret;
  return sha256Hex(`xingmang-session::${config.apiKey}::${config.rawUserPasswords}`);
}

/**
 * 常量时间遍历所有成员密码，避免通过响应耗时推测成员数量或密码前缀。
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

export async function verifySessionToken(token, config) {
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

    const entry = config.userEntries.find((u) => u.userId === payload.uid);
    if (!entry) return null;

    // 校验密码版本标签：管理员修改该成员密码后，旧 Cookie 自动失效
    const currentPv = (await sha256Hex(entry.password)).slice(0, 12);
    if (payload.pv !== currentPv) return null;

    return { userId: entry.userId };
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

export async function requireAuthenticatedUser(request, config) {
  const token = parseCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  return verifySessionToken(token, config);
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
