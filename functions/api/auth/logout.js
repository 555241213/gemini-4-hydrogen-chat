import { buildLogoutCookieHeader, jsonResponse } from "../../_lib/auth.js";

export async function onRequestPost({ request }) {
  return jsonResponse(
    { ok: true },
    200,
    {
      "Set-Cookie": buildLogoutCookieHeader(request),
    },
  );
}
