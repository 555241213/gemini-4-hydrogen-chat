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
  const BG_STORAGE_KEY = "xingmang_bg_config";
  const AUTO_EXTRACT_KEY = "xingmang_auto_extract";

  const state = {
    user: null,
    configured: true,
    missingConfig: [],
    conversations: [],
    currentConversationId: null,
    messages: [],
    characters: [],
    activeCharacterId: null,
    memories: [],
    memoryFilter: "all",
    editingCharacterId: null,
    userTurnCounter: 0,
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
  const personaBtn = document.getElementById("persona-btn");
  const memoriesBtn = document.getElementById("memories-btn");
  const bgBtn = document.getElementById("bg-btn");
  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  const themeIcon = document.getElementById("theme-icon");
  const clearBtn = document.getElementById("clear-btn");
  const adminBtn = document.getElementById("admin-btn");
  const logoutBtn = document.getElementById("logout-btn");

  const ambientBgEl = document.querySelector(".ambient-bg");
  const chatScrollArea = document.getElementById("chat-scroll-area");
  const welcomeHero = document.getElementById("welcome-hero");
  const welcomeCharAvatar = document.getElementById("welcome-char-avatar");
  const welcomeCharName = document.getElementById("welcome-char-name");
  const welcomeCharSubtitle = document.getElementById("welcome-char-subtitle");
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
  const adminTabPersona = document.getElementById("admin-tab-persona");
  const adminTabUsers = document.getElementById("admin-tab-users");
  const admSystemPrompt = document.getElementById("adm-system-prompt");
  const admPersonaMsg = document.getElementById("adm-persona-msg");
  const admPersonaResetBtn = document.getElementById("adm-persona-reset-btn");
  const admPersonaSaveBtn = document.getElementById("adm-persona-save-btn");
  const personaChips = adminModal.querySelectorAll(".persona-chip");
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

  // 角色系统与切换弹窗
  const personaModal = document.getElementById("persona-modal");
  const userPersonaCloseBtn = document.getElementById("user-persona-close-btn");
  const userPersonaStatus = document.getElementById("user-persona-status");
  const charListView = document.getElementById("char-list-view");
  const charListGrid = document.getElementById("char-list-grid");
  const charListMsg = document.getElementById("char-list-msg");
  const charCreateBtn = document.getElementById("char-create-btn");
  const charEditorView = document.getElementById("char-editor-view");
  const charAvatarInput = document.getElementById("char-avatar-input");
  const charNameInput = document.getElementById("char-name-input");
  const charPersonalityInput = document.getElementById("char-personality-input");
  const charCatchphraseInput = document.getElementById("char-catchphrase-input");
  const charBackgroundInput = document.getElementById("char-background-input");
  const charExamplesInput = document.getElementById("char-examples-input");
  const charFirstMsgInput = document.getElementById("char-first-msg-input");
  const charDefaultCheck = document.getElementById("char-default-check");
  const charEditorMsg = document.getElementById("char-editor-msg");
  const charCancelEditBtn = document.getElementById("char-cancel-edit-btn");
  const charSaveBtn = document.getElementById("char-save-btn");

  // 长期记忆本弹窗
  const memoriesModal = document.getElementById("memories-modal");
  const memoriesCloseBtn = document.getElementById("memories-close-btn");
  const memFilterBtns = memoriesModal.querySelectorAll(".mem-filter-btn");
  const memExtractBtn = document.getElementById("mem-extract-btn");
  const memAutoExtractCheck = document.getElementById("mem-auto-extract-check");
  const memAddForm = document.getElementById("mem-add-form");
  const memNewInput = document.getElementById("mem-new-input");
  const memScopeSelect = document.getElementById("mem-scope-select");
  const memMsg = document.getElementById("mem-msg");
  const memList = document.getElementById("mem-list");

  // 氛围背景弹窗
  const bgModal = document.getElementById("bg-modal");
  const bgCloseBtn = document.getElementById("bg-close-btn");
  const bgPresetGrid = document.getElementById("bg-preset-grid");
  const bgUrlInput = document.getElementById("bg-url-input");
  const bgFileInput = document.getElementById("bg-file-input");
  const bgUploadBtn = document.getElementById("bg-upload-btn");
  const bgClearCustomBtn = document.getElementById("bg-clear-custom-btn");
  const bgDimRange = document.getElementById("bg-dim-range");

  // 确认与图片放大弹窗
  const confirmModal = document.getElementById("confirm-modal");
  const confirmTitleEl = document.getElementById("confirm-title");
  const confirmDescEl = confirmModal.querySelector(".confirm-desc");
  const confirmCancelBtn = document.getElementById("confirm-cancel-btn");
  const confirmOkBtn = document.getElementById("confirm-ok-btn");
  let pendingConfirmHandler = null;
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
    personaModal.classList.add("hidden");
    memoriesModal.classList.add("hidden");
    bgModal.classList.add("hidden");
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
    personaBtn.disabled = busy;
    memoriesBtn.disabled = busy;
    bgBtn.disabled = busy;
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
    const conv = state.conversations.find(function (c) {
      return c.id === state.currentConversationId;
    });
    if (conv && conv.character_id) {
      state.activeCharacterId = conv.character_id;
    }
    updateWelcomeHero();
    setChatError(null);
    renderMessages();
    renderConversationsDrawer();
    scrollToBottom(false);
  }

  async function startNewChatWithCharacter(charId, focusComposer) {
    if (state.isStreaming) return;
    drawerBackdrop.classList.add("hidden");
    const targetCharId = charId || (getActiveCharacter() && getActiveCharacter().id) || null;
    if (targetCharId) {
      state.activeCharacterId = targetCharId;
    }

    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新对话", character_id: targetCharId }),
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
        state.messages = Array.isArray(data.messages) ? data.messages : [];
        updateWelcomeHero();
        setChatError(null);
        renderMessages();
        renderConversationsDrawer();
        if (focusComposer !== false) promptInput.focus();
      }
    } catch (_) {}
  }

  async function handleNewChat() {
    if (state.isStreaming) return;
    drawerBackdrop.classList.add("hidden");
    const activeChar = getActiveCharacter();
    const hasFirstMsg = Boolean(activeChar && activeChar.first_message);
    if (state.messages.length === 0 && !hasFirstMsg) {
      state.currentConversationId = null;
      setChatError(null);
      updateWelcomeHero();
      renderConversationsDrawer();
      promptInput.focus();
      return;
    }
    await startNewChatWithCharacter(activeChar ? activeChar.id : null, true);
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
  // 拟人化消息分割、确认弹窗与消息渲染
  // --------------------------------------------------------------------------

  function getActiveCharacter() {
    const conv = state.conversations.find(function (c) {
      return c.id === state.currentConversationId;
    });
    const targetId = (conv && conv.character_id) || state.activeCharacterId;
    if (targetId) {
      const matched = state.characters.find(function (ch) {
        return ch.id === targetId;
      });
      if (matched) return matched;
    }
    return (
      state.characters.find(function (ch) {
        return ch.is_default;
      }) ||
      state.characters[0] ||
      null
    );
  }

  function getActiveCharacterMeta() {
    const ch = getActiveCharacter();
    if (!ch) return { name: "星芒 AI", avatar: "✦" };
    return { name: ch.name || "星芒 AI", avatar: ch.avatar || "✦" };
  }

  function updateWelcomeHero() {
    const ch = getActiveCharacter();
    if (!ch) {
      welcomeCharAvatar.className = "starburst-icon";
      welcomeCharAvatar.textContent = "";
      welcomeCharName.textContent = "嗨，今天想聊点什么？";
      welcomeCharSubtitle.textContent = "日常聊天、随手提问，或者直接发张照片让我看看";
      return;
    }
    if (!ch.avatar || ch.avatar === "✦") {
      welcomeCharAvatar.className = "starburst-icon";
      welcomeCharAvatar.textContent = "";
    } else {
      welcomeCharAvatar.className = "char-emoji-icon";
      welcomeCharAvatar.textContent = ch.avatar;
    }
    welcomeCharName.textContent = ch.name;
    welcomeCharSubtitle.textContent =
      ch.personality || ch.background || "日常聊天、随手提问，或者直接发张照片让我看看";
  }

  /**
   * 按 ||| 将普通对话拆分为多条气泡（跳过围栏代码块内部，避免破坏代码）。
   */
  function splitReplySegments(rawText, keepTrailingEmpty) {
    const source = String(rawText || "").replace(/\r\n?/g, "\n");
    if (!source) return keepTrailingEmpty ? [""] : [];

    const segments = [];
    let current = "";
    let inFence = false;
    const lines = source.split("\n");

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
      }
      if (!inFence && line.includes("|||")) {
        const parts = line.split("|||");
        for (let j = 0; j < parts.length; j += 1) {
          current += (current && j === 0 ? "\n" : "") + parts[j];
          if (j < parts.length - 1) {
            segments.push(current.trim());
            current = "";
          }
        }
      } else {
        current += (current ? "\n" : "") + line;
      }
    }

    const tail = current.trim();
    if (tail || keepTrailingEmpty) {
      segments.push(tail);
    }
    return segments.filter(function (seg, idx) {
      return Boolean(seg) || (keepTrailingEmpty && idx === segments.length - 1);
    });
  }

  function openConfirmDialog(opts) {
    confirmTitleEl.textContent = opts.title || "确认操作？";
    confirmDescEl.textContent = opts.desc || "";
    confirmOkBtn.textContent = opts.okText || "确认";
    pendingConfirmHandler = typeof opts.onConfirm === "function" ? opts.onConfirm : null;
    confirmModal.classList.remove("hidden");
  }

  async function handleRollbackFromMessage(msgId) {
    if (state.isStreaming || !state.currentConversationId || !msgId) return;
    openConfirmDialog({
      title: "删除并回溯到此处？",
      desc: "这会删除该条消息以及它之后的所有对话记录，方便你重新接着聊或修改提问，且无法恢复。",
      okText: "确认删除并回溯",
      onConfirm: async function () {
        try {
          const url =
            "/api/messages?conversation_id=" +
            encodeURIComponent(state.currentConversationId) +
            "&from_id=" +
            encodeURIComponent(msgId);
          const res = await fetch(url, { method: "DELETE" });
          if (res.status === 401) {
            state.user = null;
            showAuthView();
            return;
          }
          if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            setChatError(err.detail || "回溯删除失败，请稍后重试。");
            return;
          }
          const idx = state.messages.findIndex(function (m) {
            return m.id === msgId;
          });
          if (idx >= 0) {
            state.messages = state.messages.slice(0, idx);
          }
          setChatError(null);
          renderMessages();
          await refreshConversations();
        } catch (_) {
          setChatError("回溯删除时网络异常，请重试。");
        }
      },
    });
  }

  function renderAvatarBadge(avatarText) {
    if (!avatarText || avatarText === "✦") {
      return '<span class="starburst-icon"></span>';
    }
    const span = document.createElement("span");
    span.className = "ai-avatar-badge";
    span.textContent = avatarText;
    return span.outerHTML;
  }

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

    if (msg.id) {
      const userActions = document.createElement("div");
      userActions.className = "user-msg-actions";
      const rollbackBtn = document.createElement("button");
      rollbackBtn.type = "button";
      rollbackBtn.className = "glass-action-btn";
      rollbackBtn.textContent = "🗑 回溯删除";
      rollbackBtn.disabled = state.isStreaming;
      rollbackBtn.addEventListener("click", function () {
        handleRollbackFromMessage(msg.id);
      });
      userActions.appendChild(rollbackBtn);
      row.appendChild(userActions);
    }

    return row;
  }

  function createAssistantMessageElement(msg, isLastAssistant) {
    const row = document.createElement("div");
    row.className = "assistant-msg-row";
    const meta = getActiveCharacterMeta();

    const header = document.createElement("div");
    header.className = "ai-header";
    const labelSpan = document.createElement("span");
    labelSpan.className = "ai-header-label";
    labelSpan.textContent = meta.name;
    header.innerHTML = renderAvatarBadge(meta.avatar);
    header.appendChild(labelSpan);
    row.appendChild(header);

    const stack = document.createElement("div");
    stack.className = "assistant-bubbles-stack";
    const segments = splitReplySegments(msg.content || "", false);
    const renderParts = segments.length ? segments : [msg.content || ""];

    renderParts.forEach(function (part) {
      const bubbleItem = document.createElement("div");
      bubbleItem.className = "assistant-bubble-item ai-content";
      bubbleItem.innerHTML = window.XingmangMarkdown.render(part);
      stack.appendChild(bubbleItem);
    });
    row.appendChild(stack);

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "glass-action-btn";
    copyBtn.innerHTML = "<span>📋</span><span>复制</span>";
    copyBtn.addEventListener("click", async function () {
      const plain = renderParts.join("\n\n");
      const ok = await copyText(plain);
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

    if (msg.id) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "glass-action-btn";
      editBtn.textContent = "✎ 编辑";
      editBtn.disabled = state.isStreaming;
      editBtn.addEventListener("click", function () {
        if (state.isStreaming || row.querySelector(".msg-edit-box")) return;
        stack.classList.add("hidden");
        actions.classList.add("hidden");

        const editBox = document.createElement("div");
        editBox.className = "msg-edit-box";
        const ta = document.createElement("textarea");
        ta.className = "glass-textarea";
        ta.rows = Math.min(10, Math.max(3, String(msg.content || "").split("\n").length + 1));
        ta.value = msg.content || "";

        const btnRow = document.createElement("div");
        btnRow.className = "msg-edit-actions";
        const cancelEditBtn = document.createElement("button");
        cancelEditBtn.type = "button";
        cancelEditBtn.className = "glass-action-btn";
        cancelEditBtn.textContent = "取消";
        const saveEditBtn = document.createElement("button");
        saveEditBtn.type = "button";
        saveEditBtn.className = "primary-btn";
        saveEditBtn.style.padding = "6px 14px";
        saveEditBtn.style.fontSize = "0.82rem";
        saveEditBtn.textContent = "保存修改";

        cancelEditBtn.addEventListener("click", function () {
          editBox.remove();
          stack.classList.remove("hidden");
          actions.classList.remove("hidden");
        });

        saveEditBtn.addEventListener("click", async function () {
          const nextContent = ta.value.trim();
          if (!nextContent) return;
          saveEditBtn.disabled = true;
          try {
            const res = await fetch("/api/messages", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message_id: msg.id, content: nextContent }),
            });
            if (res.status === 401) {
              state.user = null;
              showAuthView();
              return;
            }
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) {
              setChatError(data.detail || "保存修改失败。");
              return;
            }
            msg.content = (data.message && data.message.content) || nextContent;
            renderMessages();
          } catch (_) {
            setChatError("保存修改时网络异常。");
          } finally {
            saveEditBtn.disabled = false;
          }
        });

        btnRow.appendChild(cancelEditBtn);
        btnRow.appendChild(saveEditBtn);
        editBox.appendChild(ta);
        editBox.appendChild(btnRow);
        row.appendChild(editBox);
        ta.focus();
      });
      actions.appendChild(editBtn);

      const rollbackBtn = document.createElement("button");
      rollbackBtn.type = "button";
      rollbackBtn.className = "glass-action-btn";
      rollbackBtn.textContent = "🗑 回溯删除";
      rollbackBtn.disabled = state.isStreaming;
      rollbackBtn.addEventListener("click", function () {
        handleRollbackFromMessage(msg.id);
      });
      actions.appendChild(rollbackBtn);
    }

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

  function createTypingBubbleElement() {
    const el = document.createElement("div");
    el.className = "typing-bubble";
    el.innerHTML =
      '<span class="typing-dots"><span></span><span></span><span></span></span>' +
      '<span>对方正在输入…</span>';
    return el;
  }

  function createStreamingAssistantNode() {
    const row = document.createElement("div");
    row.className = "assistant-msg-row";
    const meta = getActiveCharacterMeta();

    const header = document.createElement("div");
    header.className = "ai-header";
    const labelSpan = document.createElement("span");
    labelSpan.className = "ai-header-label";
    labelSpan.textContent = meta.name;
    header.innerHTML = renderAvatarBadge(meta.avatar);
    header.appendChild(labelSpan);

    const stack = document.createElement("div");
    stack.className = "assistant-bubbles-stack";

    const typing = createTypingBubbleElement();

    row.appendChild(header);
    row.appendChild(stack);
    row.appendChild(typing);
    messagesList.appendChild(row);

    return { row: row, stack: stack, typing: typing };
  }

  function renderStreamingBubbles(streamNode, accumulated, isFinal) {
    const parts = splitReplySegments(accumulated, true);
    const activeText = parts.length ? parts[parts.length - 1] : "";
    const completed = parts.slice(0, Math.max(0, parts.length - 1));

    streamNode.stack.innerHTML = "";
    completed.forEach(function (seg) {
      if (!seg) return;
      const item = document.createElement("div");
      item.className = "assistant-bubble-item ai-content";
      item.innerHTML = window.XingmangMarkdown.render(seg);
      streamNode.stack.appendChild(item);
    });

    if (activeText) {
      const activeItem = document.createElement("div");
      activeItem.className = "assistant-bubble-item ai-content";
      activeItem.innerHTML =
        window.XingmangMarkdown.render(activeText) +
        (isFinal ? "" : '<span class="stream-cursor">▌</span>');
      streamNode.stack.appendChild(activeItem);
      streamNode.typing.classList.add("hidden");
    } else if (!isFinal) {
      streamNode.typing.classList.remove("hidden");
    } else {
      streamNode.typing.classList.add("hidden");
    }
  }

  async function playSequentialRevealIfFast(streamNode, fullText, streamStartTs) {
    const parts = splitReplySegments(fullText, false);
    if (parts.length <= 1) return;
    // 若流式总耗时极短（例如短气泡一次性推送完成），补一段轻快自然的逐条弹出节奏
    if (Date.now() - streamStartTs > 1200) return;

    streamNode.stack.innerHTML = "";
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        streamNode.typing.classList.remove("hidden");
        if (!state.userScrolledUp) scrollToBottom(false);
        await new Promise(function (resolve) {
          setTimeout(resolve, 420);
        });
      }
      streamNode.typing.classList.add("hidden");
      const item = document.createElement("div");
      item.className = "assistant-bubble-item ai-content";
      item.innerHTML = window.XingmangMarkdown.render(parts[i]);
      streamNode.stack.appendChild(item);
      if (!state.userScrolledUp) scrollToBottom(false);
    }
  }

  async function runStreamRequest(fetchPromise) {
    state.isStreaming = true;
    state.userScrolledUp = false;
    setChatError(null);
    updateControlsDisabled();
    welcomeHero.classList.add("hidden");

    const streamNode = createStreamingAssistantNode();
    const streamStartTs = Date.now();
    let accumulated = "";
    let streamSucceeded = false;
    let doneMsg = null;

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
          accumulated += piece;
          renderStreamingBubbles(streamNode, accumulated, false);
          if (!state.userScrolledUp) scrollToBottom(false);
        },
        onDone: function (assistantMsg) {
          streamSucceeded = true;
          doneMsg = assistantMsg;
          state.messages.push(assistantMsg);
        },
        onError: function (errText) {
          setChatError(errText);
        },
      });

      if (streamSucceeded && doneMsg && doneMsg.content) {
        await playSequentialRevealIfFast(streamNode, doneMsg.content, streamStartTs);
        maybeTriggerAutoMemoryExtract();
      }

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

    const activeChar = getActiveCharacter();
    await runStreamRequest(
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: state.currentConversationId,
          character_id: activeChar ? activeChar.id : null,
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
        card.dataset.modelName === activeModel &&
        (!card.dataset.baseUrl ||
          admBaseUrl.value.trim().replace(/\/+$/, "") ===
            card.dataset.baseUrl.replace(/\/+$/, ""));
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
      btn.dataset.baseUrl = preset.baseUrl;

      const title = document.createElement("div");
      title.className = "preset-card-title";
      title.textContent = preset.label;

      const desc = document.createElement("div");
      desc.className = "preset-card-desc";
      desc.textContent = preset.desc;

      btn.appendChild(title);
      btn.appendChild(desc);

      btn.addEventListener("click", function () {
        const currentUrl = admBaseUrl.value.trim();
        const isCurrentRelay =
          currentUrl.includes("vercel.app") && preset.provider === "gemini";

        admProvider.value = preset.provider;
        admModel.value = preset.modelName;
        admBaseUrl.value = isCurrentRelay ? currentUrl : preset.baseUrl;
        admEffort.value = preset.defaultEffort || "low";
        if (preset.provider === "deepseek") {
          admFallback.value = "";
        } else if (preset.modelName === "gemini-4-hydrogen") {
          admFallback.value = "gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite";
        } else if (preset.provider === "gemini" && !admFallback.value.trim()) {
          admFallback.value = "gemini-3.6-flash,gemini-3.5-flash-lite";
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

    admSystemPrompt.value = s.system_prompt || s.default_system_prompt || "";

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
    admPersonaMsg.classList.add("hidden");
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

  async function refreshCharacters() {
    const res = await fetch("/api/characters");
    if (res.status === 401) {
      state.user = null;
      showAuthView();
      return false;
    }
    if (!res.ok) return false;
    const data = await res.json();
    state.characters = Array.isArray(data.characters) ? data.characters : [];
    if (!state.activeCharacterId && state.characters.length) {
      const def =
        state.characters.find(function (c) { return c.is_default; }) || state.characters[0];
      state.activeCharacterId = def.id;
    }
    updateWelcomeHero();
    return true;
  }

  async function enterChatSession() {
    await refreshCharacters();
    const ok = await refreshConversations();
    if (!ok) return;
    const firstConv = state.conversations[0] || null;
    if (firstConv) {
      await switchConversation(firstConv.id);
    } else {
      const defChar = getActiveCharacter();
      if (defChar && defChar.first_message) {
        await startNewChatWithCharacter(defChar.id, false);
      } else {
        state.currentConversationId = null;
        state.messages = [];
      }
    }
    updateWelcomeHero();
    showAppView();
  }

  async function bootstrap() {
    initTheme();
    initBackground();

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

  const PERSONA_TEMPLATES = {
    humor:
      "你是一群好朋友群里的幽默搭子。说话接地气、机智风趣、偶尔温和地接梗吐槽，但关键时刻回答靠谱实用；不要官腔，用简洁自然的中文聊天。",
    gentle:
      "你是一位温柔、细腻、共情力很强的倾听者与生活伙伴。先接住用户的情绪再给出温暖实在的建议，语气松弛自然、不居高临下。",
    concise:
      "你是一位极简高效的日常百科助手。直接给核心结论与要点，不寒暄不铺垫，复杂问题分点说清。",
  };

  // --------------------------------------------------------------------------
  // 角色系统（列表 / 切换 / 编辑 / 新建 / 删除）
  // --------------------------------------------------------------------------

  function showCharListView() {
    charEditorMsg.classList.add("hidden");
    charEditorView.classList.add("hidden");
    charListView.classList.remove("hidden");
  }

  function showCharEditorView(charObj) {
    charListMsg.classList.add("hidden");
    charEditorMsg.classList.add("hidden");
    state.editingCharacterId = charObj ? charObj.id : null;
    charAvatarInput.value = (charObj && charObj.avatar) || "✨";
    charNameInput.value = (charObj && charObj.name) || "";
    charPersonalityInput.value = (charObj && charObj.personality) || "";
    charCatchphraseInput.value = (charObj && charObj.catchphrase) || "";
    charBackgroundInput.value = (charObj && charObj.background) || "";
    charExamplesInput.value = (charObj && charObj.examples) || "";
    charFirstMsgInput.value = (charObj && charObj.first_message) || "";
    charDefaultCheck.checked = Boolean(charObj && charObj.is_default);
    charListView.classList.add("hidden");
    charEditorView.classList.remove("hidden");
    charNameInput.focus();
  }

  function renderCharacterList() {
    charListGrid.innerHTML = "";
    const activeChar = getActiveCharacter();
    userPersonaStatus.textContent = activeChar
      ? "当前对话角色：" + activeChar.avatar + " " + activeChar.name
      : "支持多角色切换、开场白冷启动与自定义编辑";

    if (!state.characters.length) {
      const empty = document.createElement("div");
      empty.className = "conv-empty";
      empty.textContent = "暂无角色，点击右上角「＋ 新建角色」创建一个吧！";
      charListGrid.appendChild(empty);
      return;
    }

    state.characters.forEach(function (ch) {
      const isCurrent = activeChar && activeChar.id === ch.id;
      const card = document.createElement("div");
      card.className = "char-card" + (isCurrent ? " active" : "");

      const head = document.createElement("div");
      head.className = "char-card-head";

      const ident = document.createElement("div");
      ident.className = "char-card-ident";
      const av = document.createElement("span");
      av.className = "char-card-avatar";
      av.textContent = ch.avatar || "✦";
      const nameWrap = document.createElement("div");
      const nameEl = document.createElement("div");
      nameEl.className = "char-card-name";
      nameEl.textContent =
        ch.name + (ch.is_default ? " · 默认" : "") + (isCurrent ? " · 当前" : "");
      nameWrap.appendChild(nameEl);
      ident.appendChild(av);
      ident.appendChild(nameWrap);
      head.appendChild(ident);

      const desc = document.createElement("div");
      desc.className = "char-card-desc";
      desc.textContent = ch.personality || ch.background || "未填写性格简介";

      const actions = document.createElement("div");
      actions.className = "char-card-actions";

      const chatNowBtn = document.createElement("button");
      chatNowBtn.type = "button";
      chatNowBtn.className = "glass-action-btn";
      chatNowBtn.textContent = "💬 用它新开对话";
      chatNowBtn.addEventListener("click", async function () {
        personaModal.classList.add("hidden");
        await startNewChatWithCharacter(ch.id, true);
      });
      actions.appendChild(chatNowBtn);

      if (!ch.is_default) {
        const defBtn = document.createElement("button");
        defBtn.type = "button";
        defBtn.className = "glass-action-btn";
        defBtn.textContent = "设为默认";
        defBtn.addEventListener("click", async function () {
          const res = await fetch("/api/characters", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: ch.id, is_default: true }),
          });
          if (res.ok) {
            await refreshCharacters();
            renderCharacterList();
            showAdminMsg(charListMsg, "已将「" + ch.name + "」设为默认角色。", true);
          }
        });
        actions.appendChild(defBtn);
      }

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "glass-action-btn";
      editBtn.textContent = "✎ 编辑";
      editBtn.addEventListener("click", function () {
        showCharEditorView(ch);
      });
      actions.appendChild(editBtn);

      if (state.characters.length > 1) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "glass-action-btn";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", async function () {
          const res = await fetch("/api/characters?id=" + encodeURIComponent(ch.id), {
            method: "DELETE",
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) {
            showAdminMsg(charListMsg, data.detail || "删除角色失败。", false);
            return;
          }
          await refreshCharacters();
          renderCharacterList();
          renderMessages();
          showAdminMsg(charListMsg, "已删除角色「" + ch.name + "」。", true);
        });
        actions.appendChild(delBtn);
      }

      card.appendChild(head);
      card.appendChild(desc);
      card.appendChild(actions);
      charListGrid.appendChild(card);
    });
  }

  async function openCharactersModal() {
    if (state.isStreaming) return;
    charListMsg.classList.add("hidden");
    showCharListView();
    personaModal.classList.remove("hidden");
    const ok = await refreshCharacters();
    if (!ok) {
      showAdminMsg(charListMsg, "读取角色列表失败，请重试。", false);
      return;
    }
    renderCharacterList();
  }

  personaBtn.addEventListener("click", openCharactersModal);
  userPersonaCloseBtn.addEventListener("click", function () {
    personaModal.classList.add("hidden");
  });
  personaModal.addEventListener("click", function (evt) {
    if (evt.target === personaModal) personaModal.classList.add("hidden");
  });
  charCreateBtn.addEventListener("click", function () {
    showCharEditorView(null);
  });
  charCancelEditBtn.addEventListener("click", function () {
    showCharListView();
    renderCharacterList();
  });

  charEditorView.addEventListener("submit", async function (evt) {
    evt.preventDefault();
    charSaveBtn.disabled = true;
    charEditorMsg.classList.add("hidden");
    const payload = {
      avatar: charAvatarInput.value.trim() || "✦",
      name: charNameInput.value.trim(),
      personality: charPersonalityInput.value.trim(),
      catchphrase: charCatchphraseInput.value.trim(),
      background: charBackgroundInput.value.trim(),
      examples: charExamplesInput.value.trim(),
      first_message: charFirstMsgInput.value.trim(),
      is_default: charDefaultCheck.checked,
    };
    const isEdit = Boolean(state.editingCharacterId);
    if (isEdit) payload.id = state.editingCharacterId;

    try {
      const res = await fetch("/api/characters", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        showAdminMsg(charEditorMsg, data.detail || "保存角色失败。", false);
        return;
      }
      await refreshCharacters();
      showCharListView();
      renderCharacterList();
      renderMessages();
      showAdminMsg(charListMsg, "角色「" + payload.name + "」已保存！", true);
    } catch (_) {
      showAdminMsg(charEditorMsg, "保存角色时网络异常。", false);
    } finally {
      charSaveBtn.disabled = false;
    }
  });

  // --------------------------------------------------------------------------
  // 长期记忆本（查看 / 筛选 / 增删改 / 手动与自动提炼）
  // --------------------------------------------------------------------------

  function getCharNameById(charId) {
    if (!charId) return "通用记忆";
    const found = state.characters.find(function (c) { return c.id === charId; });
    return found ? found.avatar + " " + found.name : "角色专属";
  }

  function renderMemoriesList() {
    memList.innerHTML = "";
    const activeChar = getActiveCharacter();
    const activeCharId = activeChar ? activeChar.id : "";

    const filtered = state.memories.filter(function (m) {
      if (state.memoryFilter === "global") return !m.character_id;
      if (state.memoryFilter === "character") {
        return activeCharId && m.character_id === activeCharId;
      }
      return true;
    });

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "conv-empty";
      empty.textContent = "还没有记忆条目，可以在上方手动添加，或从当前对话自动提炼！";
      memList.appendChild(empty);
      return;
    }

    filtered.forEach(function (mem) {
      const card = document.createElement("div");
      card.className = "mem-item" + (mem.enabled ? "" : " disabled");

      const top = document.createElement("div");
      top.className = "mem-item-top";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = Boolean(mem.enabled);
      check.title = mem.enabled ? "已启用（点击暂停注入）" : "已暂停（点击重新启用）";
      check.addEventListener("change", async function () {
        const res = await fetch("/api/memories", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: mem.id, enabled: check.checked }),
        });
        if (res.ok) {
          mem.enabled = check.checked;
          renderMemoriesList();
        }
      });

      const textEl = document.createElement("div");
      textEl.className = "mem-item-text";
      textEl.textContent = mem.content;

      top.appendChild(check);
      top.appendChild(textEl);

      const meta = document.createElement("div");
      meta.className = "mem-item-meta";

      const badges = document.createElement("div");
      badges.className = "mem-badges";
      const scopeBadge = document.createElement("span");
      scopeBadge.className = "mem-badge";
      scopeBadge.textContent = getCharNameById(mem.character_id);
      const srcBadge = document.createElement("span");
      srcBadge.className = "mem-badge";
      srcBadge.textContent = mem.source === "auto" ? "AI 提炼" : "手动记录";
      badges.appendChild(scopeBadge);
      badges.appendChild(srcBadge);

      const ops = document.createElement("div");
      ops.className = "char-card-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "glass-action-btn";
      editBtn.textContent = "✎ 编辑";
      editBtn.addEventListener("click", function () {
        if (card.querySelector(".mem-edit-row")) return;
        const editRow = document.createElement("div");
        editRow.className = "bg-custom-row mem-edit-row";
        const inp = document.createElement("input");
        inp.type = "url";
        inp.style.flex = "1";
        inp.value = mem.content;
        inp.maxLength = 300;
        const saveB = document.createElement("button");
        saveB.type = "button";
        saveB.className = "glass-action-btn";
        saveB.textContent = "保存";
        const cancelB = document.createElement("button");
        cancelB.type = "button";
        cancelB.className = "glass-action-btn";
        cancelB.textContent = "取消";
        cancelB.addEventListener("click", function () {
          editRow.remove();
        });
        saveB.addEventListener("click", async function () {
          const val = inp.value.trim();
          if (!val) return;
          const res = await fetch("/api/memories", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: mem.id, content: val }),
          });
          if (res.ok) {
            mem.content = val;
            renderMemoriesList();
          }
        });
        editRow.appendChild(inp);
        editRow.appendChild(saveB);
        editRow.appendChild(cancelB);
        card.appendChild(editRow);
        inp.focus();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "glass-action-btn";
      delBtn.textContent = "× 删除";
      delBtn.addEventListener("click", async function () {
        const res = await fetch("/api/memories?id=" + encodeURIComponent(mem.id), {
          method: "DELETE",
        });
        if (res.ok) {
          state.memories = state.memories.filter(function (x) { return x.id !== mem.id; });
          renderMemoriesList();
        }
      });

      ops.appendChild(editBtn);
      ops.appendChild(delBtn);
      meta.appendChild(badges);
      meta.appendChild(ops);

      card.appendChild(top);
      card.appendChild(meta);
      memList.appendChild(card);
    });
  }

  async function loadMemories() {
    const res = await fetch("/api/memories");
    if (res.status === 401) {
      state.user = null;
      showAuthView();
      return false;
    }
    if (!res.ok) return false;
    const data = await res.json();
    state.memories = Array.isArray(data.memories) ? data.memories : [];
    renderMemoriesList();
    return true;
  }

  async function maybeTriggerAutoMemoryExtract() {
    let enabled = false;
    try {
      enabled = localStorage.getItem(AUTO_EXTRACT_KEY) === "1";
    } catch (_) {}
    if (!enabled || !state.currentConversationId) return;
    state.userTurnCounter += 1;
    if (state.userTurnCounter % 6 !== 0) return;

    const activeChar = getActiveCharacter();
    try {
      await fetch("/api/memories/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: state.currentConversationId,
          character_id: activeChar ? activeChar.id : "",
        }),
      });
    } catch (_) {}
  }

  memoriesBtn.addEventListener("click", async function () {
    if (state.isStreaming) return;
    memMsg.classList.add("hidden");
    try {
      memAutoExtractCheck.checked = localStorage.getItem(AUTO_EXTRACT_KEY) === "1";
    } catch (_) {}
    memoriesModal.classList.remove("hidden");
    const ok = await loadMemories();
    if (!ok) {
      showAdminMsg(memMsg, "读取记忆本失败，请稍后重试。", false);
    }
  });

  memoriesCloseBtn.addEventListener("click", function () {
    memoriesModal.classList.add("hidden");
  });
  memoriesModal.addEventListener("click", function (evt) {
    if (evt.target === memoriesModal) memoriesModal.classList.add("hidden");
  });

  memFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.memoryFilter = btn.dataset.filter || "all";
      memFilterBtns.forEach(function (b) {
        b.classList.toggle("active", b.dataset.filter === state.memoryFilter);
      });
      renderMemoriesList();
    });
  });

  memAutoExtractCheck.addEventListener("change", function () {
    try {
      localStorage.setItem(AUTO_EXTRACT_KEY, memAutoExtractCheck.checked ? "1" : "0");
    } catch (_) {}
  });

  memAddForm.addEventListener("submit", async function (evt) {
    evt.preventDefault();
    const content = memNewInput.value.trim();
    if (!content) return;
    const activeChar = getActiveCharacter();
    const scopeId =
      memScopeSelect.value === "__current__" && activeChar ? activeChar.id : "";
    try {
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content, character_id: scopeId }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        showAdminMsg(memMsg, data.detail || "添加记忆失败。", false);
        return;
      }
      memNewInput.value = "";
      if (data.memory) {
        state.memories.unshift(data.memory);
        renderMemoriesList();
      }
      showAdminMsg(memMsg, "已记入长期记忆本！", true);
    } catch (_) {
      showAdminMsg(memMsg, "添加记忆时网络异常。", false);
    }
  });

  memExtractBtn.addEventListener("click", async function () {
    if (!state.currentConversationId) {
      showAdminMsg(memMsg, "请先进行一段对话后再提炼记忆。", false);
      return;
    }
    memExtractBtn.disabled = true;
    showAdminMsg(memMsg, "正在分析当前对话，提炼长期记忆要点...", true);
    const activeChar = getActiveCharacter();
    try {
      const res = await fetch("/api/memories/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: state.currentConversationId,
          character_id: activeChar ? activeChar.id : "",
        }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        showAdminMsg(memMsg, data.detail || "记忆提炼失败。", false);
        return;
      }
      if (Array.isArray(data.memories)) {
        state.memories = data.memories;
        renderMemoriesList();
      }
      showAdminMsg(memMsg, data.detail || "记忆提炼完成。", true);
    } catch (_) {
      showAdminMsg(memMsg, "提炼记忆时网络异常。", false);
    } finally {
      memExtractBtn.disabled = false;
    }
  });

  // --------------------------------------------------------------------------
  // 氛围感聊天背景切换（预设光晕 + 自定义壁纸 + 遮罩强度）
  // --------------------------------------------------------------------------

  const BG_PRESETS = [
    {
      id: "starlight",
      label: "星芒深空",
      css: "radial-gradient(58% 46% at 14% 6%, rgba(99, 102, 241, 0.24) 0%, transparent 70%), radial-gradient(52% 44% at 88% 90%, rgba(56, 189, 248, 0.20) 0%, transparent 72%)",
    },
    {
      id: "rainy",
      label: "深夜雨窗",
      css: "radial-gradient(62% 52% at 22% 14%, rgba(59, 130, 246, 0.22) 0%, transparent 72%), radial-gradient(54% 48% at 80% 82%, rgba(14, 165, 233, 0.16) 0%, transparent 74%)",
    },
    {
      id: "sakura",
      label: "樱落霓虹",
      css: "radial-gradient(60% 48% at 18% 12%, rgba(244, 114, 182, 0.20) 0%, transparent 70%), radial-gradient(56% 48% at 86% 85%, rgba(168, 85, 247, 0.20) 0%, transparent 72%)",
    },
    {
      id: "forest",
      label: "森林微光",
      css: "radial-gradient(58% 48% at 20% 10%, rgba(16, 185, 129, 0.18) 0%, transparent 70%), radial-gradient(52% 44% at 85% 88%, rgba(20, 184, 166, 0.16) 0%, transparent 72%)",
    },
    {
      id: "pure",
      label: "极简纯夜",
      css: "none",
    },
  ];

  function loadBgConfig() {
    try {
      const raw = localStorage.getItem(BG_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { preset: "starlight", customUrl: "", dim: 56 };
  }

  function saveAndApplyBgConfig(cfg) {
    try {
      localStorage.setItem(BG_STORAGE_KEY, JSON.stringify(cfg));
    } catch (_) {}

    if (cfg.customUrl) {
      ambientBgEl.style.backgroundImage = 'url("' + cfg.customUrl.replace(/"/g, "") + '")';
      ambientBgEl.style.setProperty("--bg-dim", String((Number(cfg.dim || 56) / 100).toFixed(2)));
    } else {
      const p =
        BG_PRESETS.find(function (x) { return x.id === cfg.preset; }) || BG_PRESETS[0];
      ambientBgEl.style.backgroundImage = p.css === "none" ? "none" : p.css;
      ambientBgEl.style.setProperty("--bg-dim", "0");
    }
    renderBgPresets(cfg);
  }

  function renderBgPresets(cfg) {
    if (!bgPresetGrid) return;
    const current = cfg || loadBgConfig();
    bgPresetGrid.innerHTML = "";
    BG_PRESETS.forEach(function (preset) {
      const card = document.createElement("button");
      card.type = "button";
      card.className =
        "bg-preset-card" + (!current.customUrl && current.preset === preset.id ? " active" : "");
      const swatch = document.createElement("div");
      swatch.className = "bg-swatch";
      swatch.style.backgroundColor = "var(--bg-base)";
      if (preset.css !== "none") swatch.style.backgroundImage = preset.css;
      const label = document.createElement("span");
      label.textContent = preset.label;
      label.style.fontSize = "0.8rem";
      card.appendChild(swatch);
      card.appendChild(label);
      card.addEventListener("click", function () {
        const next = loadBgConfig();
        next.preset = preset.id;
        next.customUrl = "";
        bgUrlInput.value = "";
        saveAndApplyBgConfig(next);
      });
      bgPresetGrid.appendChild(card);
    });
  }

  function initBackground() {
    const cfg = loadBgConfig();
    bgDimRange.value = String(cfg.dim || 56);
    bgUrlInput.value = cfg.customUrl && !cfg.customUrl.startsWith("data:") ? cfg.customUrl : "";
    saveAndApplyBgConfig(cfg);
  }

  bgBtn.addEventListener("click", function () {
    const cfg = loadBgConfig();
    bgDimRange.value = String(cfg.dim || 56);
    renderBgPresets(cfg);
    bgModal.classList.remove("hidden");
  });
  bgCloseBtn.addEventListener("click", function () {
    bgModal.classList.add("hidden");
  });
  bgModal.addEventListener("click", function (evt) {
    if (evt.target === bgModal) bgModal.classList.add("hidden");
  });
  bgUrlInput.addEventListener("change", function () {
    const val = bgUrlInput.value.trim();
    if (val && !/^https?:\/\//i.test(val)) return;
    const cfg = loadBgConfig();
    cfg.customUrl = val;
    saveAndApplyBgConfig(cfg);
  });
  bgUploadBtn.addEventListener("click", function () {
    bgFileInput.click();
  });
  bgFileInput.addEventListener("change", async function () {
    const file = bgFileInput.files && bgFileInput.files[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageToDataUrl(file);
      const cfg = loadBgConfig();
      cfg.customUrl = dataUrl;
      bgUrlInput.value = "";
      saveAndApplyBgConfig(cfg);
    } catch (_) {}
  });
  bgClearCustomBtn.addEventListener("click", function () {
    const cfg = loadBgConfig();
    cfg.customUrl = "";
    bgUrlInput.value = "";
    bgFileInput.value = "";
    saveAndApplyBgConfig(cfg);
  });
  bgDimRange.addEventListener("input", function () {
    const cfg = loadBgConfig();
    cfg.dim = Number(bgDimRange.value || 56);
    saveAndApplyBgConfig(cfg);
  });

  themeToggleBtn.addEventListener("click", function () {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  clearBtn.addEventListener("click", function () {
    if (state.isStreaming || !state.messages.length) return;
    openConfirmDialog({
      title: "清空当前对话？",
      desc: "这会永久删除当前这一条对话里的云端聊天记录与图片，且无法恢复。",
      okText: "确认清空",
      onConfirm: async function () {
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
      },
    });
  });

  confirmCancelBtn.addEventListener("click", function () {
    pendingConfirmHandler = null;
    confirmModal.classList.add("hidden");
  });

  confirmOkBtn.addEventListener("click", async function () {
    confirmModal.classList.add("hidden");
    const handler = pendingConfirmHandler;
    pendingConfirmHandler = null;
    if (handler) {
      await handler();
    }
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
      adminTabPersona.classList.toggle("hidden", target !== "persona");
      adminTabUsers.classList.toggle("hidden", target !== "users");
      if (target === "persona" && admSystemPrompt) {
        admSystemPrompt.focus();
      }
    });
  });

  personaChips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      const key = chip.dataset.persona;
      if (key === "default") {
        admSystemPrompt.value =
          (state.adminSettings && state.adminSettings.default_system_prompt) || "";
      } else if (PERSONA_TEMPLATES[key]) {
        admSystemPrompt.value = PERSONA_TEMPLATES[key];
      }
      admSystemPrompt.focus();
    });
  });

  admPersonaResetBtn.addEventListener("click", function () {
    admSystemPrompt.value =
      (state.adminSettings && state.adminSettings.default_system_prompt) || "";
  });

  admPersonaSaveBtn.addEventListener("click", async function () {
    admPersonaSaveBtn.disabled = true;
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: admSystemPrompt.value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        showAdminMsg(admPersonaMsg, data.detail || "保存人设失败。", false);
        return;
      }
      applySettingsToAdminForm(data.settings);
      showAdminMsg(admPersonaMsg, "AI 人设已保存，全站下一条消息立即生效！", true);
    } catch (_) {
      showAdminMsg(admPersonaMsg, "保存失败，请检查网络。", false);
    } finally {
      admPersonaSaveBtn.disabled = false;
    }
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
    state.characters = [];
    state.activeCharacterId = null;
    state.memories = [];
    state.userTurnCounter = 0;
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
