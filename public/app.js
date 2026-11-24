/**
 * 星芒 AI · 前端状态管理、多对话切换、管理员后台、图片压缩与 SSE 流式渲染
 */
(function () {
  "use strict";

  const MAX_INPUT_CHARS = 12000;
  const MAX_IMAGE_SIDE = 1024;
  const JPEG_QUALITY = 0.8;
  const MAX_DATA_URL_LEN = 650000;
  const THEME_STORAGE_KEY = "xingmang_theme";

  const state = {
    user: null,
    configured: true,
    missingConfig: [],
    conversations: [],
    currentConversationId: null,
    messages: [],
    isStreaming: false,
    selectedFile: null,
    selectedPreviewUrl: null,
    userScrolledUp: false,
    lastError: null,
    adminPresets: [],
    adminSettings: null,
  };

  // DOM 引用
  const authView = document.getElementById("auth-view");
  const appView = document.getElementById("app-view");
  const configWarning = document.getElementById("config-warning");
  const authForm = document.getElementById("auth-form");
  const authPassword = document.getElementById("auth-password");
  const authError = document.getElementById("auth-error");
  const authSubmitBtn = document.getElementById("auth-submit-btn");

  const historyDrawerBtn = document.getElementById("history-drawer-btn");
  const navUserPill = document.getElementById("nav-user-pill");
  const newChatBtn = document.getElementById("new-chat-btn");
  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  const themeIcon = document.getElementById("theme-icon");
  const clearBtn = document.getElementById("clear-btn");
  const adminBtn = document.getElementById("admin-btn");
  const logoutBtn = document.getElementById("logout-btn");

  const chatScrollArea = document.getElementById("chat-scroll-area");
  const welcomeHero = document.getElementById("welcome-hero");
  const messagesList = document.getElementById("messages-list");
  const chatErrorBox = document.getElementById("chat-error-box");
  const chatErrorText = document.getElementById("chat-error-text");
  const retryBtn = document.getElementById("retry-btn");
  const scrollBottomBtn = document.getElementById("scroll-bottom-btn");

  const composerForm = document.getElementById("composer-form");
  const imageFileInput = document.getElementById("image-file-input");
  const attachBtn = document.getElementById("attach-btn");
  const promptInput = document.getElementById("prompt-input");
  const charCounter = document.getElementById("char-counter");
  const sendBtn = document.getElementById("send-btn");
  const imagePreviewBar = document.getElementById("image-preview-bar");
  const imagePreviewThumb = document.getElementById("image-preview-thumb");
  const imagePreviewName = document.getElementById("image-preview-name");
  const imageRemoveBtn = document.getElementById("image-remove-btn");

  // 历史对话抽屉
  const drawerBackdrop = document.getElementById("drawer-backdrop");
  const drawerCloseBtn = document.getElementById("drawer-close-btn");
  const drawerNewChatBtn = document.getElementById("drawer-new-chat-btn");
  const conversationsList = document.getElementById("conversations-list");

  // 管理员后台弹窗
  const adminModal = document.getElementById("admin-modal");
  const adminCloseBtn = document.getElementById("admin-close-btn");
  const adminTabs = adminModal.querySelectorAll(".admin-tab");
  const adminTabModels = document.getElementById("admin-tab-models");
  const adminTabUsers = document.getElementById("admin-tab-users");
  const presetGrid = document.getElementById("preset-grid");
  const admProvider = document.getElementById("adm-provider");
  const admModel = document.getElementById("adm-model");
  const admBaseUrl = document.getElementById("adm-base-url");
  const admEffort = document.getElementById("adm-effort");
  const admFallback = document.getElementById("adm-fallback");
  const admDeepseekKey = document.getElementById("adm-deepseek-key");
  const admGeminiKey = document.getElementById("adm-gemini-key");
  const admCustomKey = document.getElementById("adm-custom-key");
  const admCustomKeyGroup = document.getElementById("adm-custom-key-group");
  const admDeepseekStatus = document.getElementById("adm-deepseek-status");
  const admGeminiStatus = document.getElementById("adm-gemini-status");
  const admCustomStatus = document.getElementById("adm-custom-status");
  const admModelMsg = document.getElementById("adm-model-msg");
  const admTestBtn = document.getElementById("adm-test-btn");
  const admSaveBtn = document.getElementById("adm-save-btn");
  const admUsersList = document.getElementById("adm-users-list");
  const admAddUserForm = document.getElementById("adm-add-user-form");
  const admNewUid = document.getElementById("adm-new-uid");
  const admNewPwd = document.getElementById("adm-new-pwd");
  const admUserMsg = document.getElementById("adm-user-msg");

  // 确认与图片放大弹窗
  const confirmModal = document.getElementById("confirm-modal");
  const confirmCancelBtn = document.getElementById("confirm-cancel-btn");
  const confirmOkBtn = document.getElementById("confirm-ok-btn");
  const lightboxModal = document.getElementById("lightbox-modal");
  const lightboxImg = document.getElementById("lightbox-img");

  // --------------------------------------------------------------------------
  // 主题与剪贴板工具
  // --------------------------------------------------------------------------

  function applyTheme(theme) {
    const resolved = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", resolved);
    themeIcon.textContent = resolved === "dark" ? "☀️" : "🌙";
    themeToggleBtn.title = resolved === "dark" ? "切换浅色模式" : "切换深色模式";
    try {
      localStorage.setItem(THEME_STORAGE_KEY, resolved);
    } catch (_) {}
  }

  function initTheme() {
    let saved = "dark";
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY) || "dark";
    } catch (_) {}
    applyTheme(saved);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }

  function decodeBase64Utf8(b64) {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, function (c) {
      return c.charCodeAt(0);
    });
    return new TextDecoder("utf-8").decode(bytes);
  }

  // --------------------------------------------------------------------------
  // 视图切换与控件状态
  // --------------------------------------------------------------------------

  function showAuthView() {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    drawerBackdrop.classList.add("hidden");
    adminModal.classList.add("hidden");
    if (!state.configured) {
      const missingText = state.missingConfig.length
        ? state.missingConfig.join("、")
        : "GEMINI_API_KEY / DEEPSEEK_API_KEY、USER_PASSWORDS、D1 数据库绑定（DB）";
      configWarning.textContent =
        "服务尚未完成初始化配置，缺少：" +
        missingText +
        "。请前往 Cloudflare Pages 后台补充配置后刷新页面。";
      configWarning.classList.remove("hidden");
    } else {
      configWarning.classList.add("hidden");
    }
    authError.classList.add("hidden");
  }

  function showAppView() {
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    navUserPill.textContent = state.user ? state.user.display_name || state.user.username : "";
    adminBtn.classList.toggle("hidden", !(state.user && state.user.is_admin));
    renderMessages();
    updateControlsDisabled();
    scrollToBottom(false);
  }

  function updateControlsDisabled() {
    const busy = state.isStreaming;
    historyDrawerBtn.disabled = busy;
    newChatBtn.disabled = busy;
    drawerNewChatBtn.disabled = busy;
    themeToggleBtn.disabled = busy;
    clearBtn.disabled = busy || state.messages.length === 0;
    adminBtn.disabled = busy;
    logoutBtn.disabled = busy;
    attachBtn.disabled = busy;
    promptInput.disabled = busy;
    sendBtn.disabled = busy;
    retryBtn.disabled = busy;

    const regenBtn = messagesList.querySelector(".regen-action-btn");
    if (regenBtn) regenBtn.disabled = busy;
  }

  function setChatError(msg) {
    state.lastError = msg || null;
    if (!state.lastError) {
      chatErrorBox.classList.add("hidden");
      chatErrorText.textContent = "";
      retryBtn.classList.add("hidden");
      return;
    }
    chatErrorText.textContent = state.lastError;
    chatErrorBox.classList.remove("hidden");
    const last = state.messages[state.messages.length - 1];
    const canRetry = !state.isStreaming && last && last.role === "user";
    retryBtn.classList.toggle("hidden", !canRetry);
  }

  // --------------------------------------------------------------------------
  // 智能滚底控制
  // --------------------------------------------------------------------------

  function updateScrollBottomState() {
    const dist =
      chatScrollArea.scrollHeight - chatScrollArea.scrollTop - chatScrollArea.clientHeight;
    const scrolledUp = dist > 140;
    state.userScrolledUp = scrolledUp;
    scrollBottomBtn.classList.toggle("visible", scrolledUp && state.messages.length > 0);
  }

  function scrollToBottom(smooth) {
    chatScrollArea.scrollTo({
      top: chatScrollArea.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    state.userScrolledUp = false;
    scrollBottomBtn.classList.remove("visible");
  }

  // --------------------------------------------------------------------------
  // 多对话管理（新建对话 / 切换 / 删除）
  // --------------------------------------------------------------------------

  function renderConversationsDrawer() {
    conversationsList.innerHTML = "";
    if (!state.conversations.length) {
      const empty = document.createElement("div");
      empty.className = "conv-empty";
      empty.textContent = "还没有历史对话，直接发送消息或点上方新建吧";
      conversationsList.appendChild(empty);
      return;
    }

    state.conversations.forEach(function (conv) {
      const row = document.createElement("div");
      row.className =
        "conv-item" + (conv.id === state.currentConversationId ? " active" : "");

      const title = document.createElement("span");
      title.className = "conv-item-title";
      title.textContent = conv.title || "新对话";

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "conv-item-del";
      delBtn.title = "删除该对话";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", async function (evt) {
        evt.stopPropagation();
        await deleteConversationById(conv.id);
      });

      row.addEventListener("click", async function () {
        drawerBackdrop.classList.add("hidden");
        if (conv.id !== state.currentConversationId) {
          await switchConversation(conv.id);
        }
      });

      row.appendChild(title);
      row.appendChild(delBtn);
      conversationsList.appendChild(row);
    });
  }

  async function refreshConversations() {
    const res = await fetch("/api/conversations");
    if (res.status === 401) {
      state.user = null;
      showAuthView();
      return false;
    }
    const data = await res.json();
    state.conversations = data.conversations || [];
    renderConversationsDrawer();
    return true;
  }

  async function switchConversation(conversationId) {
    if (!conversationId) {
      state.currentConversationId = null;
      state.messages = [];
      setChatError(null);
      renderMessages();
      renderConversationsDrawer();
      return;
    }

    const res = await fetch(
      "/api/messages?conversation_id=" + encodeURIComponent(conversationId),
    );
    if (res.status === 401) {
      state.user = null;
      showAuthView();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    state.currentConversationId = data.conversation_id;
    state.messages = data.messages || [];
    setChatError(null);
    renderMessages();
    renderConversationsDrawer();
    scrollToBottom(false);
  }

  async function handleNewChat() {
    if (state.isStreaming) return;
    drawerBackdrop.classList.add("hidden");
    // 如果当前本来就是空的新对话，只聚焦输入框即可，不产生无意义的空记录
    if (state.messages.length === 0) {
      state.currentConversationId = null;
      setChatError(null);
      renderConversationsDrawer();
      promptInput.focus();
      return;
    }

    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新对话" }),
      });
      if (res.status === 401) {
        state.user = null;
        showAuthView();
        return;
      }
      const data = await res.json();
      if (data.conversation) {
        state.conversations.unshift(data.conversation);
        state.currentConversationId = data.conversation.id;
        state.messages = [];
        setChatError(null);
        renderMessages();
        renderConversationsDrawer();
        promptInput.focus();
      }
    } catch (_) {}
  }

  async function deleteConversationById(conversationId) {
    if (state.isStreaming) return;
    try {
      const res = await fetch(
        "/api/conversations?id=" + encodeURIComponent(conversationId),
        { method: "DELETE" },
      );
      if (!res.ok) return;
      state.conversations = state.conversations.filter(function (c) {
        return c.id !== conversationId;
      });
      if (state.currentConversationId === conversationId) {
        const next = state.conversations[0] || null;
        await switchConversation(next ? next.id : null);
      } else {
        renderConversationsDrawer();
      }
    } catch (_) {}
  }

  // --------------------------------------------------------------------------
  // 消息渲染
  // --------------------------------------------------------------------------

  function createUserMessageElement(msg) {
    const row = document.createElement("div");
    row.className = "user-msg-row";

    const bubble = document.createElement("div");
    bubble.className = "user-bubble";

    if (msg.image_url) {
      const img = document.createElement("img");
      img.className = "user-bubble-img";
      img.src = msg.image_url;
      img.alt = "已上传图片";
      img.addEventListener("click", function () {
        lightboxImg.src = msg.image_url;
        lightboxModal.classList.remove("hidden");
      });
      bubble.appendChild(img);
    }

    if (msg.content) {
      const p = document.createElement("p");
      p.className = "user-bubble-text";
      p.textContent = msg.content;
      bubble.appendChild(p);
    } else if (msg.image_url) {
      const cap = document.createElement("div");
      cap.className = "user-bubble-caption";
      cap.textContent = "（已发送图片）";
      bubble.appendChild(cap);
    }

    row.appendChild(bubble);
    return row;
  }

  function createAssistantMessageElement(msg, isLastAssistant) {
    const row = document.createElement("div");
    row.className = "assistant-msg-row";

    const header = document.createElement("div");
    header.className = "ai-header";
    header.innerHTML =
      '<span class="starburst-icon"></span>' +
      '<span class="ai-header-label">星芒 AI</span>';
    row.appendChild(header);

    const body = document.createElement("div");
    body.className = "ai-content";
    body.innerHTML = window.XingmangMarkdown.render(msg.content || "");
    row.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "glass-action-btn";
    copyBtn.innerHTML = "<span>📋</span><span>复制</span>";
    copyBtn.addEventListener("click", async function () {
      const ok = await copyText(msg.content || "");
      if (ok) {
        copyBtn.classList.add("copied");
        copyBtn.innerHTML = "<span>✓</span><span>已复制</span>";
        setTimeout(function () {
          copyBtn.classList.remove("copied");
          copyBtn.innerHTML = "<span>📋</span><span>复制</span>";
        }, 1800);
      }
    });
    actions.appendChild(copyBtn);

    if (isLastAssistant) {
      const regenBtn = document.createElement("button");
      regenBtn.type = "button";
      regenBtn.className = "glass-action-btn regen-action-btn";
      regenBtn.textContent = "↻ 重新生成";
      regenBtn.disabled = state.isStreaming;
      regenBtn.addEventListener("click", function () {
        handleRegenerate();
      });
      actions.appendChild(regenBtn);
    }

    row.appendChild(actions);
    return row;
  }

  function renderMessages() {
    messagesList.innerHTML = "";
    const total = state.messages.length;
    welcomeHero.classList.toggle("hidden", total > 0 || state.isStreaming);

    state.messages.forEach(function (msg, idx) {
      if (msg.role === "user") {
        messagesList.appendChild(createUserMessageElement(msg));
      } else {
        const isLastAssistant = idx === total - 1;
        messagesList.appendChild(createAssistantMessageElement(msg, isLastAssistant));
      }
    });

    const last = state.messages[total - 1];
    if (!state.isStreaming && last && last.role === "user") {
      if (!state.lastError) {
        setChatError("上一条提问尚未收到回复，可点击下方重试。");
      } else {
        retryBtn.classList.remove("hidden");
      }
    } else if (!state.lastError) {
      setChatError(null);
    }

    updateControlsDisabled();
    updateScrollBottomState();
  }

  messagesList.addEventListener("click", async function (evt) {
    const copyBtn = evt.target.closest(".glass-code-copy-btn");
    if (!copyBtn) return;
    const b64 = copyBtn.getAttribute("data-code-b64") || "";
    const ok = await copyText(decodeBase64Utf8(b64));
    if (ok) {
      copyBtn.classList.add("copied");
      copyBtn.textContent = "✓ 已复制";
      setTimeout(function () {
        copyBtn.classList.remove("copied");
        copyBtn.textContent = "复制";
      }, 1800);
    }
  });

  // --------------------------------------------------------------------------
  // 浏览器端低成本图片压缩（白底合成透明通道、<=1024px、JPEG 80）
  // --------------------------------------------------------------------------

  function loadImageSource(file) {
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file).then(function (bitmap) {
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw: function (ctx, w, h) {
            ctx.drawImage(bitmap, 0, 0, w, h);
          },
          cleanup: function () {
            if (typeof bitmap.close === "function") bitmap.close();
          },
        };
      });
    }
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        resolve({
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          draw: function (ctx, w, h) {
            ctx.drawImage(img, 0, 0, w, h);
          },
          cleanup: function () {
            URL.revokeObjectURL(url);
          },
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("图片读取失败，请更换一张图片重试。"));
      };
      img.src = url;
    });
  }

  async function compressImageToDataUrl(file) {
    const source = await loadImageSource(file);
    try {
      const renderScaled = function (maxSide, quality) {
        const longest = Math.max(source.width, source.height) || 1;
        const scale = longest > maxSide ? maxSide / longest : 1;
        const targetW = Math.max(1, Math.round(source.width * scale));
        const targetH = Math.max(1, Math.round(source.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("当前浏览器不支持图片压缩处理。");
        }
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, targetW, targetH);
        source.draw(ctx, targetW, targetH);
        return canvas.toDataURL("image/jpeg", quality);
      };

      const attempts = [
        [MAX_IMAGE_SIDE, JPEG_QUALITY],
        [MAX_IMAGE_SIDE, 0.65],
        [800, 0.6],
      ];
      for (let i = 0; i < attempts.length; i += 1) {
        const dataUrl = renderScaled(attempts[i][0], attempts[i][1]);
        if (dataUrl.length <= MAX_DATA_URL_LEN) {
          return dataUrl;
        }
      }
      return renderScaled(640, 0.55);
    } finally {
      source.cleanup();
    }
  }

  // --------------------------------------------------------------------------
  // API 请求与 SSE 流式解析
  // --------------------------------------------------------------------------

  async function consumeSseStream(response, handlers) {
    if (!response.ok) {
      let detail = "请求失败，请稍后重试。";
      try {
        const errJson = await response.json();
        if (errJson && errJson.detail) detail = errJson.detail;
      } catch (_) {}
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      let sepIdx;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawBlock = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        if (!rawBlock.trim()) continue;

        let eventName = "message";
        const dataLines = [];
        rawBlock.split("\n").forEach(function (line) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        });
        if (!dataLines.length) continue;

        let payload = {};
        try {
          payload = JSON.parse(dataLines.join("\n"));
        } catch (_) {
          continue;
        }

        if (eventName === "conversation_updated" && handlers.onConversationUpdated) {
          handlers.onConversationUpdated(payload.conversation);
        } else if (eventName === "user_saved" && handlers.onUserSaved) {
          handlers.onUserSaved(payload.message);
        } else if (eventName === "delta" && handlers.onDelta) {
          handlers.onDelta(payload.text || "");
        } else if (eventName === "done" && handlers.onDone) {
          handlers.onDone(payload.message);
        } else if (eventName === "error" && handlers.onError) {
          handlers.onError(payload.error || "回复时出了点小状况，请稍后重试。");
        }
      }
    }
  }

  function createStreamingAssistantNode() {
    const row = document.createElement("div");
    row.className = "assistant-msg-row";

    const header = document.createElement("div");
    header.className = "ai-header";
    header.innerHTML =
      '<span class="starburst-icon"></span>' +
      '<span class="ai-header-label">星芒 AI</span>';

    const pulse = document.createElement("div");
    pulse.className = "thinking-pulse";
    pulse.textContent = "✦ 正在回复中...";

    const contentEl = document.createElement("div");
    contentEl.className = "ai-content";

    row.appendChild(header);
    row.appendChild(pulse);
    row.appendChild(contentEl);
    messagesList.appendChild(row);

    return { row: row, pulse: pulse, contentEl: contentEl };
  }

  async function runStreamRequest(fetchPromise) {
    state.isStreaming = true;
    state.userScrolledUp = false;
    setChatError(null);
    updateControlsDisabled();
    welcomeHero.classList.add("hidden");

    const streamNode = createStreamingAssistantNode();
    let accumulated = "";
    let firstChunk = false;
    let streamSucceeded = false;

    if (!state.userScrolledUp) {
      scrollToBottom(false);
    }

    try {
      const response = await fetchPromise;
      if (response.status === 401) {
        state.user = null;
        showAuthView();
        return;
      }

      await consumeSseStream(response, {
        onConversationUpdated: function (conv) {
          if (!conv) return;
          state.currentConversationId = conv.id;
          const idx = state.conversations.findIndex(function (c) {
            return c.id === conv.id;
          });
          if (idx >= 0) {
            state.conversations[idx] = conv;
          } else {
            state.conversations.unshift(conv);
          }
          renderConversationsDrawer();
        },
        onUserSaved: function (userMsg) {
          state.messages.push(userMsg);
          const userEl = createUserMessageElement(userMsg);
          messagesList.insertBefore(userEl, streamNode.row);
          if (!state.userScrolledUp) scrollToBottom(false);
        },
        onDelta: function (piece) {
          if (!piece) return;
          if (!firstChunk) {
            firstChunk = true;
            streamNode.pulse.remove();
          }
          accumulated += piece;
          streamNode.contentEl.innerHTML =
            window.XingmangMarkdown.render(accumulated) +
            '<span class="stream-cursor">▌</span>';
          if (!state.userScrolledUp) scrollToBottom(false);
        },
        onDone: function (assistantMsg) {
          streamSucceeded = true;
          state.messages.push(assistantMsg);
        },
        onError: function (errText) {
          setChatError(errText);
        },
      });

      if (!streamSucceeded && !state.lastError) {
        setChatError("⚠️ 连接提前中断，请点击下方重试。");
      }
    } catch (err) {
      setChatError(err.message || "⚠️ 请求失败，请稍后重试。");
    } finally {
      state.isStreaming = false;
      renderMessages();
      if (streamSucceeded && !state.userScrolledUp) {
        scrollToBottom(false);
      }
    }
  }

  // --------------------------------------------------------------------------
  // 图片附件与发送交互
  // --------------------------------------------------------------------------

  function clearSelectedImage() {
    if (state.selectedPreviewUrl) {
      URL.revokeObjectURL(state.selectedPreviewUrl);
    }
    state.selectedFile = null;
    state.selectedPreviewUrl = null;
    imageFileInput.value = "";
    imagePreviewBar.classList.add("hidden");
  }

  function setSelectedImage(file) {
    if (!file) return;
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (file.type && !allowed.includes(file.type)) {
      setChatError("仅支持 PNG、JPG、WebP 格式图片。");
      return;
    }
    clearSelectedImage();
    state.selectedFile = file;
    state.selectedPreviewUrl = URL.createObjectURL(file);
    imagePreviewThumb.src = state.selectedPreviewUrl;
    imagePreviewName.textContent = file.name || "粘贴的图片";
    imagePreviewBar.classList.remove("hidden");
    setChatError(null);
  }

  function resizeTextarea() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + "px";
    const len = promptInput.value.length;
    if (len >= 10000) {
      charCounter.textContent = len + "/" + MAX_INPUT_CHARS;
      charCounter.classList.remove("hidden");
    } else {
      charCounter.classList.add("hidden");
    }
  }

  async function handleSend(evt) {
    if (evt) evt.preventDefault();
    if (state.isStreaming) return;

    const text = promptInput.value.trim();
    const file = state.selectedFile;

    if (!text && !file) {
      setChatError("请输入内容或上传一张图片后再发送。");
      return;
    }
    if (text.length > MAX_INPUT_CHARS) {
      setChatError("单次输入长度不能超过 12,000 个字符，请精简后再发送。");
      return;
    }

    let imageDataUrl = null;
    if (file) {
      try {
        imageDataUrl = await compressImageToDataUrl(file);
      } catch (err) {
        setChatError(err.message || "图片处理失败，请更换 PNG / JPG / WebP 图片重试。");
        return;
      }
    }

    promptInput.value = "";
    resizeTextarea();
    clearSelectedImage();

    await runStreamRequest(
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: state.currentConversationId,
          content: text,
          image_data_url: imageDataUrl,
        }),
      }),
    );
  }

  async function handleRetry() {
    if (state.isStreaming || !state.currentConversationId) return;
    await runStreamRequest(
      fetch("/api/chat/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: state.currentConversationId }),
      }),
    );
  }

  async function handleRegenerate() {
    if (state.isStreaming || !state.currentConversationId) return;
    if (!state.messages.length || state.messages[state.messages.length - 1].role !== "assistant") {
      return;
    }
    state.messages.pop();
    renderMessages();
    await runStreamRequest(
      fetch("/api/chat/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: state.currentConversationId }),
      }),
    );
  }

  // --------------------------------------------------------------------------
  // 管理员后台逻辑（切换模型 / 测试连通性 / 管理成员）
  // --------------------------------------------------------------------------

  function showAdminMsg(el, text, isOk) {
    el.textContent = text;
    el.className = "admin-msg " + (isOk ? "ok" : "err");
  }

  function highlightMatchingPreset() {
    const activeProvider = admProvider.value;
    const activeModel = admModel.value.trim();
    const cards = presetGrid.querySelectorAll(".preset-card");
    cards.forEach(function (card) {
      const match =
        card.dataset.provider === activeProvider &&
        card.dataset.modelName === activeModel;
      card.classList.toggle("active", match);
    });
    admCustomKeyGroup.classList.toggle("hidden", activeProvider !== "custom");
  }

  function renderAdminPresets() {
    presetGrid.innerHTML = "";
    state.adminPresets.forEach(function (preset) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset-card";
      btn.dataset.provider = preset.provider;
      btn.dataset.modelName = preset.modelName;

      const title = document.createElement("div");
      title.className = "preset-card-title";
      title.textContent = preset.label;

      const desc = document.createElement("div");
      desc.className = "preset-card-desc";
      desc.textContent = preset.desc;

      btn.appendChild(title);
      btn.appendChild(desc);

      btn.addEventListener("click", function () {
        admProvider.value = preset.provider;
        admModel.value = preset.modelName;
        admBaseUrl.value = preset.baseUrl;
        if (preset.provider === "deepseek") {
          admFallback.value = "";
        } else if (preset.modelName === "gemini-4-hydrogen" && !admFallback.value.trim()) {
          admFallback.value = "gemini-3.8-flash";
        }
        highlightMatchingPreset();
      });

      presetGrid.appendChild(btn);
    });
    highlightMatchingPreset();
  }

  function applySettingsToAdminForm(s) {
    state.adminSettings = s;
    admProvider.value = s.provider || "gemini";
    admModel.value = s.model_name || "";
    admBaseUrl.value = s.base_url || "";
    admEffort.value = s.reasoning_effort || "low";
    admFallback.value = s.fallback_model || "";

    admDeepseekKey.value = "";
    admGeminiKey.value = "";
    admCustomKey.value = "";

    admDeepseekStatus.textContent = s.has_deepseek_key
      ? "已配置（" + s.deepseek_key_masked + "）"
      : "未配置";
    admDeepseekStatus.className = "key-badge" + (s.has_deepseek_key ? "" : " missing");

    admGeminiStatus.textContent = s.has_gemini_key
      ? "已配置（" + s.gemini_key_masked + "）"
      : "未配置";
    admGeminiStatus.className = "key-badge" + (s.has_gemini_key ? "" : " missing");

    admCustomStatus.textContent = s.has_custom_key
      ? "已配置（" + s.custom_key_masked + "）"
      : "未单独配置";
    admCustomStatus.className = "key-badge" + (s.has_custom_key ? "" : " missing");

    renderAdminPresets();
  }

  async function loadAdminUsers() {
    const res = await fetch("/api/admin/users");
    if (!res.ok) return;
    const data = await res.json();
    admUsersList.innerHTML = "";

    (data.users || []).forEach(function (u) {
      const row = document.createElement("div");
      row.className = "adm-user-row";

      const meta = document.createElement("div");
      meta.className = "adm-user-meta";

      const name = document.createElement("span");
      name.className = "adm-user-name";
      name.textContent = u.user_id;
      meta.appendChild(name);

      if (u.is_admin) {
        const tag = document.createElement("span");
        tag.className = "adm-tag admin";
        tag.textContent = "管理员";
        meta.appendChild(tag);
      }

      const srcTag = document.createElement("span");
      srcTag.className = "adm-tag";
      srcTag.textContent =
        u.source === "db" ? "后台添加" : u.source === "env+db" ? "密钥+后台覆盖" : "环境变量";
      meta.appendChild(srcTag);

      const countTag = document.createElement("span");
      countTag.className = "adm-tag";
      countTag.textContent = u.message_count + " 条消息";
      meta.appendChild(countTag);

      row.appendChild(meta);

      if (u.source === "db" && (!state.user || u.user_id !== state.user.username)) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "glass-action-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", async function () {
          const delRes = await fetch(
            "/api/admin/users?user_id=" + encodeURIComponent(u.user_id),
            { method: "DELETE" },
          );
          if (delRes.ok) {
            showAdminMsg(admUserMsg, "已移除成员 " + u.user_id, true);
            await loadAdminUsers();
          }
        });
        row.appendChild(delBtn);
      }

      admUsersList.appendChild(row);
    });
  }

  async function openAdminModal() {
    if (!state.user || !state.user.is_admin || state.isStreaming) return;
    admModelMsg.classList.add("hidden");
    admUserMsg.classList.add("hidden");
    adminModal.classList.remove("hidden");

    try {
      const res = await fetch("/api/admin/settings");
      if (!res.ok) {
        showAdminMsg(admModelMsg, "加载后台配置失败。", false);
        return;
      }
      const data = await res.json();
      state.adminPresets = data.presets || [];
      applySettingsToAdminForm(data.settings || {});
      await loadAdminUsers();
    } catch (_) {
      showAdminMsg(admModelMsg, "加载后台配置时网络异常。", false);
    }
  }

  function collectAdminModelPayload() {
    return {
      provider: admProvider.value,
      model_name: admModel.value.trim(),
      base_url: admBaseUrl.value.trim(),
      reasoning_effort: admEffort.value,
      fallback_model: admFallback.value.trim(),
      deepseek_api_key: admDeepseekKey.value.trim(),
      gemini_api_key: admGeminiKey.value.trim(),
      custom_api_key: admCustomKey.value.trim(),
    };
  }

  // --------------------------------------------------------------------------
  // 登录与初始化引导
  // --------------------------------------------------------------------------

  async function enterChatSession() {
    const ok = await refreshConversations();
    if (!ok) return;
    const firstConv = state.conversations[0] || null;
    if (firstConv) {
      await switchConversation(firstConv.id);
    } else {
      state.currentConversationId = null;
      state.messages = [];
    }
    showAppView();
  }

  async function bootstrap() {
    initTheme();

    try {
      const healthRes = await fetch("/api/health");
      const health = await healthRes.json();
      state.configured = Boolean(health.configured);
      state.missingConfig = Array.isArray(health.missing) ? health.missing : [];
    } catch (_) {}

    try {
      const meRes = await fetch("/api/auth/me");
      if (meRes.ok) {
        const meData = await meRes.json();
        state.user = meData.user;
        await enterChatSession();
        return;
      }
    } catch (_) {}

    showAuthView();
  }

  // 事件绑定
  authForm.addEventListener("submit", async function (evt) {
    evt.preventDefault();
    authError.classList.add("hidden");
    authSubmitBtn.disabled = true;

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: authPassword.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        authError.textContent = data.detail || "登录失败，请重试。";
        authError.classList.remove("hidden");
        return;
      }
      state.user = data.user;
      authPassword.value = "";
      await enterChatSession();
    } catch (_) {
      authError.textContent = "网络异常，请稍后再试。";
      authError.classList.remove("hidden");
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  historyDrawerBtn.addEventListener("click", async function () {
    if (state.isStreaming) return;
    await refreshConversations();
    drawerBackdrop.classList.remove("hidden");
  });

  drawerCloseBtn.addEventListener("click", function () {
    drawerBackdrop.classList.add("hidden");
  });

  drawerBackdrop.addEventListener("click", function (evt) {
    if (evt.target === drawerBackdrop) drawerBackdrop.classList.add("hidden");
  });

  newChatBtn.addEventListener("click", handleNewChat);
  drawerNewChatBtn.addEventListener("click", handleNewChat);

  themeToggleBtn.addEventListener("click", function () {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  clearBtn.addEventListener("click", function () {
    if (state.isStreaming || !state.messages.length) return;
    confirmModal.classList.remove("hidden");
  });

  confirmCancelBtn.addEventListener("click", function () {
    confirmModal.classList.add("hidden");
  });

  confirmOkBtn.addEventListener("click", async function () {
    confirmModal.classList.add("hidden");
    try {
      const url = state.currentConversationId
        ? "/api/messages?conversation_id=" + encodeURIComponent(state.currentConversationId)
        : "/api/messages";
      const res = await fetch(url, { method: "DELETE" });
      if (res.ok) {
        state.messages = [];
        setChatError(null);
        renderMessages();
        await refreshConversations();
      }
    } catch (_) {}
  });

  adminBtn.addEventListener("click", openAdminModal);
  adminCloseBtn.addEventListener("click", function () {
    adminModal.classList.add("hidden");
  });
  adminModal.addEventListener("click", function (evt) {
    if (evt.target === adminModal) adminModal.classList.add("hidden");
  });

  adminTabs.forEach(function (tabBtn) {
    tabBtn.addEventListener("click", function () {
      const target = tabBtn.dataset.tab;
      adminTabs.forEach(function (b) {
        b.classList.toggle("active", b.dataset.tab === target);
      });
      adminTabModels.classList.toggle("hidden", target !== "models");
      adminTabUsers.classList.toggle("hidden", target !== "users");
    });
  });

  admProvider.addEventListener("change", function () {
    if (admProvider.value === "deepseek") {
      admBaseUrl.value = "https://api.deepseek.com/";
      if (!admModel.value.trim() || admModel.value.startsWith("gemini-")) {
        admModel.value = "deepseek-flash";
      }
    } else if (admProvider.value === "gemini") {
      admBaseUrl.value = "https://generativelanguage.googleapis.com/v1beta/openai/";
      if (!admModel.value.trim() || admModel.value.startsWith("deepseek-")) {
        admModel.value = "gemini-4-hydrogen";
      }
    }
    highlightMatchingPreset();
  });

  admModel.addEventListener("input", highlightMatchingPreset);

  admTestBtn.addEventListener("click", async function () {
    admTestBtn.disabled = true;
    showAdminMsg(admModelMsg, "正在向模型发送连通性测试...", true);
    try {
      const res = await fetch("/api/admin/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectAdminModelPayload()),
      });
      const data = await res.json();
      showAdminMsg(admModelMsg, data.detail || "测试完成", Boolean(data.ok));
    } catch (_) {
      showAdminMsg(admModelMsg, "测试请求失败，请检查网络。", false);
    } finally {
      admTestBtn.disabled = false;
    }
  });

  admSaveBtn.addEventListener("click", async function () {
    admSaveBtn.disabled = true;
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectAdminModelPayload()),
      });
      const data = await res.json();
      if (!res.ok) {
        showAdminMsg(admModelMsg, data.detail || "保存失败。", false);
        return;
      }
      applySettingsToAdminForm(data.settings);
      showAdminMsg(
        admModelMsg,
        "已保存并立即生效！当前全站使用：" + data.settings.model_name,
        true,
      );
    } catch (_) {
      showAdminMsg(admModelMsg, "保存失败，请检查网络。", false);
    } finally {
      admSaveBtn.disabled = false;
    }
  });

  admAddUserForm.addEventListener("submit", async function (evt) {
    evt.preventDefault();
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: admNewUid.value.trim(),
          password: admNewPwd.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAdminMsg(admUserMsg, data.detail || "操作失败。", false);
        return;
      }
      admNewUid.value = "";
      admNewPwd.value = "";
      showAdminMsg(admUserMsg, "成员密码已保存并立即生效。", true);
      await loadAdminUsers();
    } catch (_) {
      showAdminMsg(admUserMsg, "网络异常，请稍后再试。", false);
    }
  });

  logoutBtn.addEventListener("click", async function () {
    if (state.isStreaming) return;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (_) {}
    state.user = null;
    state.conversations = [];
    state.currentConversationId = null;
    state.messages = [];
    clearSelectedImage();
    setChatError(null);
    showAuthView();
  });

  attachBtn.addEventListener("click", function () {
    if (!state.isStreaming) imageFileInput.click();
  });

  imageFileInput.addEventListener("change", function () {
    if (imageFileInput.files && imageFileInput.files[0]) {
      setSelectedImage(imageFileInput.files[0]);
    }
  });

  imageRemoveBtn.addEventListener("click", clearSelectedImage);

  promptInput.addEventListener("input", resizeTextarea);

  promptInput.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
      evt.preventDefault();
      handleSend();
    }
  });

  promptInput.addEventListener("paste", function (evt) {
    const items = evt.clipboardData && evt.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type && items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) {
          setSelectedImage(file);
          break;
        }
      }
    }
  });

  composerForm.addEventListener("submit", handleSend);
  retryBtn.addEventListener("click", handleRetry);

  chatScrollArea.addEventListener("scroll", updateScrollBottomState, { passive: true });
  scrollBottomBtn.addEventListener("click", function () {
    scrollToBottom(true);
  });

  lightboxModal.addEventListener("click", function () {
    lightboxModal.classList.add("hidden");
    lightboxImg.src = "";
  });

  confirmModal.addEventListener("click", function (evt) {
    if (evt.target === confirmModal) confirmModal.classList.add("hidden");
  });

  bootstrap();
})();
