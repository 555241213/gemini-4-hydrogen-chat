import { jsonResponse, requireAuthenticatedUser } from "../_lib/auth.js";
import { loadConfig, MAX_IMAGE_DATA_URL_LEN, MAX_INPUT_CHARS } from "../_lib/config.js";
import {
  checkRateLimit,
  createConversation,
  getCharacterById,
  getConversation,
  getDefaultCharacter,
  insertMessage,
  summarizeTitle,
  updateConversationMeta,
} from "../_lib/db.js";
import { createChatSseResponse } from "../_lib/sse.js";

export async function onRequestPost({ request, env }) {
  const config = loadConfig(env);
  if (!config.hasDb) {
    return jsonResponse({ detail: "服务尚未完成数据库绑定。" }, 503);
  }
  const user = await requireAuthenticatedUser(request, config, env.DB);
  if (!user) {
    return jsonResponse({ detail: "未登录或登录已过期。" }, 401);
  }

  const limit = await checkRateLimit(env.DB, `chat:${user.userId}`, 20, 60);
  if (!limit.allowed) {
    return jsonResponse(
      { detail: `⏳ 发送消息太快了，请在 ${limit.retryAfter} 秒后再试。` },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ detail: "请求数据格式错误。" }, 400);
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  const imageDataUrl =
    typeof body.image_data_url === "string" && body.image_data_url.trim()
      ? body.image_data_url.trim()
      : null;
  let conversationId =
    typeof body.conversation_id === "string" && body.conversation_id.trim()
      ? body.conversation_id.trim()
      : null;
  const requestedCharId =
    typeof body.character_id === "string" && body.character_id.trim()
      ? body.character_id.trim()
      : null;

  if (!content && !imageDataUrl) {
    return jsonResponse({ detail: "请输入内容或上传一张图片后再发送。" }, 400);
  }
  if (content.length > MAX_INPUT_CHARS) {
    return jsonResponse(
      { detail: `单次输入长度不能超过 ${MAX_INPUT_CHARS.toLocaleString()} 个字符。` },
      400,
    );
  }
  if (imageDataUrl) {
    if (!imageDataUrl.startsWith("data:image/jpeg;base64,")) {
      return jsonResponse({ detail: "图片格式无效，请重新选择图片上传。" }, 400);
    }
    if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LEN) {
      return jsonResponse({ detail: "图片压缩后仍过大，请换一张较小的图片。" }, 400);
    }
  }

  let conversation = null;
  let updatedConversation = null;

  if (conversationId) {
    conversation = await getConversation(env.DB, user.userId, conversationId);
    if (!conversation) {
      return jsonResponse({ detail: "目标对话不存在或已被删除。" }, 404);
    }
    if (conversation.title === "新对话") {
      const nextTitle = summarizeTitle(content, Boolean(imageDataUrl));
      await updateConversationMeta(env.DB, user.userId, conversationId, nextTitle);
      updatedConversation = { ...conversation, title: nextTitle };
    }
  } else {
    const title = summarizeTitle(content, Boolean(imageDataUrl));
    let char = requestedCharId
      ? await getCharacterById(env.DB, user.userId, requestedCharId)
      : await getDefaultCharacter(env.DB, user.userId);
    if (requestedCharId && !char) {
      char = await getDefaultCharacter(env.DB, user.userId);
    }
    conversation = await createConversation(
      env.DB,
      user.userId,
      title,
      char ? char.id : null,
    );
    conversationId = conversation.id;
    updatedConversation = conversation;
  }

  const savedUserMsg = await insertMessage(env.DB, {
    userId: user.userId,
    conversationId,
    role: "user",
    content,
    imageData: imageDataUrl,
  });

  return createChatSseResponse({
    db: env.DB,
    config,
    userId: user.userId,
    conversationId,
    preSavedUserMsg: savedUserMsg,
    updatedConversation,
  });
}
