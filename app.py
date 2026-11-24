"""
星芒 AI · 小圈子日常聊天应用（Streamlit + Gemini OpenAI 兼容端点）

定位：面向 10 人以内小圈子的极简日常聊天工具
- 去除侧边栏、Token 统计、System Prompt 配置、模型切换与思考过程折叠等技术面板，只保留纯粹的日常对话与发图识图。
- 延续「深邃毛玻璃风」视觉：默认深墨蓝黑（#090C14）+ 低饱和靛蓝/青蓝光晕，支持顶部一键切换浅色/深色。
- 后台静默保留安全与成本防线：登录门禁、最近 6 轮滑动窗口、单轮传图压缩（<=1024px JPEG 80）、输入 12,000 字 / 输出 4,096 token 上限。
"""

from __future__ import annotations

import base64
import hmac
import io
import os
import time
from typing import Any

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)
from PIL import Image, ImageOps, UnidentifiedImageError
import streamlit as st
import streamlit.components.v1 as components

# ==============================================================================
# 全局常量配置（后台静默控制成本与稳定性）
# ==============================================================================

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_MODEL_NAME = "gemini-4-hydrogen"
DEFAULT_REASONING_EFFORT = "low"

DEFAULT_SYSTEM_PROMPT = (
    "你是一位亲切、自然、乐于助人的日常 AI 助手。"
    "请用通俗清晰、友好自然的中文回答用户的日常聊天、生活建议、文字润色和图片识别问题。"
)

MAX_INPUT_CHARS = 12000
MAX_OUTPUT_TOKENS = 4096
MAX_IMAGE_SIDE = 1024
JPEG_QUALITY = 80
API_TIMEOUT_SECONDS = 60.0
API_MAX_RETRIES = 1
DEFAULT_CONTEXT_TURNS = 6

# 空状态 4 张日常聊天毛玻璃快捷卡片
QUICK_PROMPTS: list[dict[str, str]] = [
    {
        "title": "🍳 今晚吃点什么",
        "desc": "告诉我冰箱里还有哪些食材，帮你快速搭配几道家常菜",
        "prompt": "我平时下班不想花太长时间做饭，请推荐 3 道 15 分钟内能搞定、常见食材就能做的快手家常菜，简单写下做法。",
    },
    {
        "title": "✍️ 润色一条消息",
        "desc": "把想说的话改得更礼貌、自然或高情商，方便直接发给别人",
        "prompt": "请帮我把这句话润色成更自然礼貌的表达（提供口语友好版和正式得体版各一条）：「不好意思，这件事我这周可能赶不完，得下周初才能给你。」",
    },
    {
        "title": "✈️ 周末轻松出行",
        "desc": "策划一次不赶时间、适合放松发呆的周末半日或一日游",
        "prompt": "帮我设计一个轻松不累的周末一日城市漫步计划，包含上午、午饭、下午茶和傍晚安排，重点是节奏慢、氛围好。",
    },
    {
        "title": "💡 讲个有趣知识",
        "desc": "用大白话聊一个贴近日常、听完会觉得很有意思的冷知识",
        "prompt": "用通俗有趣的聊天口吻，给我讲一个贴近日常生活的冷知识，不要太学术，3 分钟内能看完。",
    },
]


# ==============================================================================
# 配置读取与客户端初始化
# ==============================================================================


def get_config_value(key: str) -> str | None:
    """优先从环境变量读取配置，若未设置则回退读取 Streamlit Secrets（兼容 Streamlit Cloud）。"""
    if key in os.environ:
        return os.environ[key]
    try:
        if key in st.secrets:
            value = st.secrets[key]
            return "" if value is None else str(value)
    except Exception:  # noqa: BLE001
        pass
    return None


def load_config() -> dict[str, Any]:
    """从环境变量或 Streamlit Secrets 读取运行配置，杜绝硬编码敏感信息。"""
    api_key = (get_config_value("GEMINI_API_KEY") or "").strip()
    access_password = (get_config_value("ACCESS_PASSWORD") or "").strip()
    base_url = (get_config_value("BASE_URL") or "").strip() or DEFAULT_BASE_URL
    model_name = (get_config_value("MODEL_NAME") or "").strip() or DEFAULT_MODEL_NAME

    # 思考深度控制：默认 "low"，显式置空或误配 "none" 时不传该参数
    raw_effort = get_config_value("REASONING_EFFORT")
    if raw_effort is None:
        reasoning_effort: str | None = DEFAULT_REASONING_EFFORT
    else:
        cleaned_effort = raw_effort.strip().lower()
        reasoning_effort = (
            cleaned_effort if cleaned_effort and cleaned_effort != "none" else None
        )

    return {
        "api_key": api_key,
        "access_password": access_password,
        "base_url": base_url,
        "model_name": model_name,
        "reasoning_effort": reasoning_effort,
    }


@st.cache_resource(show_spinner=False)
def get_openai_client(api_key: str, base_url: str) -> OpenAI:
    """初始化并复用 OpenAI 兼容客户端，显式设置超时与最大重试次数。"""
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=API_TIMEOUT_SECONDS,
        max_retries=API_MAX_RETRIES,
    )


def init_session_state() -> None:
    """初始化会话级状态变量。"""
    defaults: dict[str, Any] = {
        "authenticated": False,
        "theme_mode": "dark",
        "messages": [],
        "is_generating": False,
        "pending_generation": False,
        "last_error": None,
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value


# ==============================================================================
# 「深邃毛玻璃风」全局 CSS 与客户端交互增强
# ==============================================================================


def inject_glass_theme_css(theme_mode: str) -> None:
    """根据当前主题模式（dark / light）注入深邃毛玻璃风全局样式表。"""
    is_dark = theme_mode == "dark"

    if is_dark:
        tokens = {
            "bg_base": "#090C14",
            "glow_1": "rgba(99, 102, 241, 0.22)",
            "glow_2": "rgba(56, 189, 248, 0.18)",
            "glass_bg": "rgba(20, 26, 42, 0.66)",
            "glass_bg_hover": "rgba(28, 37, 60, 0.78)",
            "glass_border": "rgba(148, 163, 184, 0.15)",
            "glass_border_focus": "rgba(129, 140, 248, 0.35)",
            "accent": "#6366F1",
            "accent_soft": "rgba(99, 102, 241, 0.22)",
            "accent_border": "rgba(129, 140, 248, 0.34)",
            "text_primary": "#F1F5F9",
            "text_secondary": "#A6B4CC",
            "input_bg": "rgba(20, 26, 42, 0.74)",
            "bottom_fade": "linear-gradient(to top, rgba(9, 12, 20, 0.96) 58%, rgba(9, 12, 20, 0) 100%)",
            "shadow_soft": "0 14px 36px rgba(0, 0, 0, 0.45)",
            "shadow_card": "0 8px 28px rgba(0, 0, 0, 0.28)",
        }
    else:
        tokens = {
            "bg_base": "#F3F6FC",
            "glow_1": "rgba(99, 102, 241, 0.13)",
            "glow_2": "rgba(56, 189, 248, 0.12)",
            "glass_bg": "rgba(255, 255, 255, 0.74)",
            "glass_bg_hover": "rgba(255, 255, 255, 0.92)",
            "glass_border": "rgba(15, 23, 42, 0.11)",
            "glass_border_focus": "rgba(99, 102, 241, 0.42)",
            "accent": "#6366F1",
            "accent_soft": "rgba(99, 102, 241, 0.13)",
            "accent_border": "rgba(99, 102, 241, 0.28)",
            "text_primary": "#0F172A",
            "text_secondary": "#475569",
            "input_bg": "rgba(255, 255, 255, 0.84)",
            "bottom_fade": "linear-gradient(to top, rgba(243, 246, 252, 0.97) 58%, rgba(243, 246, 252, 0) 100%)",
            "shadow_soft": "0 12px 32px rgba(15, 23, 42, 0.10)",
            "shadow_card": "0 8px 24px rgba(15, 23, 42, 0.06)",
        }

    css = f"""
    <style>
    :root {{
        --bg-base: {tokens["bg_base"]};
        --glow-1: {tokens["glow_1"]};
        --glow-2: {tokens["glow_2"]};
        --glass-bg: {tokens["glass_bg"]};
        --glass-bg-hover: {tokens["glass_bg_hover"]};
        --glass-border: {tokens["glass_border"]};
        --glass-border-focus: {tokens["glass_border_focus"]};
        --accent: {tokens["accent"]};
        --accent-soft: {tokens["accent_soft"]};
        --accent-border: {tokens["accent_border"]};
        --text-primary: {tokens["text_primary"]};
        --text-secondary: {tokens["text_secondary"]};
        --input-bg: {tokens["input_bg"]};
        --bottom-fade: {tokens["bottom_fade"]};
        --shadow-soft: {tokens["shadow_soft"]};
        --shadow-card: {tokens["shadow_card"]};
        --code-bg: #141720;
        --code-border: rgba(148, 163, 184, 0.16);
    }}

    /* ===== 全局画布与低饱和径向光晕 ===== */
    html, body, [data-testid="stAppViewContainer"], .stApp {{
        background-color: var(--bg-base) !important;
        color: var(--text-primary) !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                     "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
    }}

    [data-testid="stAppViewContainer"] {{
        background-image:
            radial-gradient(58% 46% at 14% 6%, var(--glow-1) 0%, transparent 70%),
            radial-gradient(52% 44% at 88% 90%, var(--glow-2) 0%, transparent 72%) !important;
        background-attachment: fixed !important;
    }}

    /* 纯净聊天界面：隐藏默认顶栏、侧边栏入口与页脚水印 */
    header[data-testid="stHeader"],
    section[data-testid="stSidebar"],
    [data-testid="stSidebarCollapsedControl"],
    [data-testid="stDecoration"],
    #MainMenu,
    footer {{
        display: none !important;
    }}

    .stMainBlockContainer,
    [data-testid="stMainBlockContainer"] {{
        max-width: 100% !important;
        padding: 0 !important;
    }}

    iframe[height="0"] {{
        display: block !important;
        height: 0 !important;
        min-height: 0 !important;
        border: none !important;
        margin: 0 !important;
        padding: 0 !important;
    }}

    /* ===== 顶部固定毛玻璃导航栏（高度 56px）===== */
    .st-key-top_navbar {{
        position: sticky !important;
        top: 0 !important;
        z-index: 990 !important;
        width: 100% !important;
        height: 56px !important;
        min-height: 56px !important;
        max-height: 56px !important;
        padding: 0 20px !important;
        background: var(--glass-bg) !important;
        backdrop-filter: blur(16px) !important;
        -webkit-backdrop-filter: blur(16px) !important;
        border-bottom: 1px solid var(--glass-border) !important;
        display: flex !important;
        align-items: center !important;
        box-sizing: border-box !important;
    }}

    .st-key-top_navbar > div,
    .st-key-top_navbar [data-testid="stVerticalBlock"],
    .st-key-top_navbar [data-testid="stHorizontalBlock"] {{
        width: 100% !important;
        gap: 0.45rem !important;
        align-items: center !important;
        margin: 0 !important;
        padding: 0 !important;
    }}

    .st-key-top_navbar [data-testid="stElementContainer"] {{
        margin: 0 !important;
    }}

    .nav-brand {{
        display: inline-flex;
        align-items: center;
        gap: 10px;
        height: 36px;
        user-select: none;
    }}

    .starburst-icon {{
        display: inline-block;
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        background-repeat: no-repeat;
        background-position: center;
        background-size: contain;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='2' y1='2' x2='22' y2='22' gradientUnits='userSpaceOnUse'%3E%3Cstop stop-color='%23818CF8'/%3E%3Cstop offset='1' stop-color='%2338BDF8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M12 1.5L14.45 9.55L22.5 12L14.45 14.45L12 22.5L9.55 14.45L1.5 12L9.55 9.55L12 1.5Z' fill='url(%23g)'/%3E%3C/svg%3E");
        filter: drop-shadow(0 0 8px rgba(99, 102, 241, 0.45));
    }}

    .nav-title {{
        font-size: 0.98rem;
        font-weight: 650;
        letter-spacing: 0.01em;
        color: var(--text-primary);
        white-space: nowrap;
    }}

    .st-key-theme_toggle_btn button,
    .st-key-nav_clear_btn button,
    .st-key-nav_logout_btn button {{
        width: 36px !important;
        height: 36px !important;
        min-height: 36px !important;
        padding: 0 !important;
        border-radius: 10px !important;
        background: transparent !important;
        border: 1px solid var(--glass-border) !important;
        color: var(--text-primary) !important;
        font-size: 0.95rem !important;
        transition: all 0.18s ease !important;
    }}

    .st-key-theme_toggle_btn button:hover:not(:disabled),
    .st-key-nav_clear_btn button:hover:not(:disabled),
    .st-key-nav_logout_btn button:hover:not(:disabled) {{
        background: var(--glass-bg-hover) !important;
        border-color: var(--glass-border-focus) !important;
    }}

    /* ===== 内容区居中且最大宽度 768px ===== */
    .st-key-chat_stage {{
        max-width: 768px !important;
        width: 100% !important;
        margin: 0 auto !important;
        padding: 24px 20px 140px 20px !important;
        box-sizing: border-box !important;
    }}

    /* ===== 空状态欢迎语 + 4 张毛玻璃快捷提问卡片 ===== */
    .welcome-hero {{
        text-align: center;
        padding: 52px 12px 32px 12px;
    }}

    .welcome-badge {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: 18px;
        background: var(--glass-bg);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid var(--glass-border);
        box-shadow: var(--shadow-card), 0 0 28px rgba(99, 102, 241, 0.20);
        margin-bottom: 18px;
    }}

    .welcome-badge .starburst-icon {{
        width: 28px;
        height: 28px;
    }}

    .welcome-title {{
        margin: 0 0 8px 0;
        font-size: 1.75rem;
        font-weight: 680;
        letter-spacing: -0.02em;
        color: var(--text-primary);
    }}

    .welcome-subtitle {{
        margin: 0;
        font-size: 0.94rem;
        color: var(--text-secondary);
        line-height: 1.6;
    }}

    [class*="st-key-quick_card_"] button {{
        width: 100% !important;
        min-height: 96px !important;
        height: auto !important;
        padding: 15px 18px !important;
        text-align: left !important;
        justify-content: flex-start !important;
        align-items: flex-start !important;
        background: var(--glass-bg) !important;
        backdrop-filter: blur(16px) !important;
        -webkit-backdrop-filter: blur(16px) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 16px !important;
        box-shadow: var(--shadow-card) !important;
        color: var(--text-primary) !important;
        transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease !important;
    }}

    [class*="st-key-quick_card_"] button:hover:not(:disabled) {{
        transform: translateY(-2px) !important;
        background: var(--glass-bg-hover) !important;
        border-color: var(--glass-border-focus) !important;
        box-shadow: var(--shadow-soft), 0 0 0 1px rgba(129, 140, 248, 0.22) !important;
    }}

    [class*="st-key-quick_card_"] button p {{
        text-align: left !important;
        line-height: 1.55 !important;
        white-space: pre-line !important;
        font-size: 0.88rem !important;
        color: var(--text-secondary) !important;
    }}

    [class*="st-key-quick_card_"] button p strong {{
        display: block !important;
        font-size: 0.94rem !important;
        font-weight: 600 !important;
        color: var(--text-primary) !important;
        margin-bottom: 4px !important;
    }}

    /* ===== 消息排版层级 ===== */
    [class*="st-key-user_msg_"] {{
        width: 100% !important;
        margin: 14px 0 20px 0 !important;
    }}

    [class*="st-key-user_bubble_"] {{
        width: fit-content !important;
        max-width: 82% !important;
        margin-left: auto !important;
        margin-right: 0 !important;
        padding: 12px 16px !important;
        background: var(--accent-soft) !important;
        backdrop-filter: blur(14px) !important;
        -webkit-backdrop-filter: blur(14px) !important;
        border: 1px solid var(--accent-border) !important;
        border-radius: 18px 18px 4px 18px !important;
        box-shadow: var(--shadow-card) !important;
    }}

    [class*="st-key-user_bubble_"] p,
    [class*="st-key-user_bubble_"] li {{
        color: var(--text-primary) !important;
        font-size: 0.95rem !important;
        line-height: 1.68 !important;
        margin-bottom: 0.35rem !important;
    }}

    [class*="st-key-user_bubble_"] p:last-child {{
        margin-bottom: 0 !important;
    }}

    [class*="st-key-user_bubble_"] img {{
        border-radius: 12px !important;
        margin-bottom: 8px !important;
    }}

    [class*="st-key-assistant_msg_"] {{
        width: 100% !important;
        background: transparent !important;
        border: none !important;
        padding: 4px 2px 10px 2px !important;
        margin: 8px 0 18px 0 !important;
    }}

    .ai-header {{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        user-select: none;
    }}

    .ai-header .starburst-icon {{
        width: 16px;
        height: 16px;
    }}

    .ai-header-label {{
        font-size: 0.80rem;
        font-weight: 600;
        color: var(--text-secondary);
        letter-spacing: 0.02em;
    }}

    [class*="st-key-assistant_msg_"] [data-testid="stMarkdownContainer"] {{
        color: var(--text-primary) !important;
        font-size: 0.97rem !important;
        line-height: 1.78 !important;
    }}

    [class*="st-key-assistant_msg_"] [data-testid="stMarkdownContainer"] p,
    [class*="st-key-assistant_msg_"] [data-testid="stMarkdownContainer"] li {{
        color: var(--text-primary) !important;
    }}

    [class*="st-key-assistant_msg_"] [data-testid="stMarkdownContainer"] a {{
        color: #818CF8 !important;
    }}

    /* 悬停平滑显示「复制」「重新生成」 */
    [class*="st-key-msg_actions_"] {{
        opacity: 0;
        transform: translateY(3px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        margin-top: 6px !important;
    }}

    [class*="st-key-assistant_msg_"]:hover [class*="st-key-msg_actions_"],
    [class*="st-key-assistant_msg_"]:focus-within [class*="st-key-msg_actions_"] {{
        opacity: 1 !important;
        transform: translateY(0) !important;
    }}

    @media (hover: none) {{
        [class*="st-key-msg_actions_"] {{
            opacity: 0.9 !important;
            transform: none !important;
        }}
    }}

    [class*="st-key-msg_actions_"] [data-testid="stHorizontalBlock"] {{
        gap: 8px !important;
        align-items: center !important;
    }}

    [class*="st-key-msg_actions_"] button,
    .glass-action-btn {{
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 5px !important;
        height: 30px !important;
        min-height: 30px !important;
        padding: 0 11px !important;
        border-radius: 999px !important;
        background: var(--glass-bg) !important;
        backdrop-filter: blur(12px) !important;
        border: 1px solid var(--glass-border) !important;
        color: var(--text-secondary) !important;
        font-size: 0.78rem !important;
        font-weight: 500 !important;
        cursor: pointer !important;
        white-space: nowrap !important;
        transition: all 0.16s ease !important;
    }}

    [class*="st-key-msg_actions_"] button:hover,
    .glass-action-btn:hover {{
        color: var(--text-primary) !important;
        background: var(--glass-bg-hover) !important;
        border-color: var(--glass-border-focus) !important;
    }}

    .glass-action-btn.copied {{
        color: #34D399 !important;
        border-color: rgba(52, 211, 153, 0.42) !important;
    }}

    /* ===== 代码块：#141720 深色圆角卡片 + 顶部语言栏 ===== */
    [data-testid="stCode"],
    [class*="st-key-assistant_msg_"] pre {{
        background: var(--code-bg) !important;
        border: 1px solid var(--code-border) !important;
        border-radius: 12px !important;
        overflow: hidden !important;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.26) !important;
    }}

    [data-testid="stCode"] pre {{
        background: var(--code-bg) !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        margin: 0 !important;
        padding: 14px 16px !important;
        color: #E2E8F0 !important;
    }}

    [data-testid="stCode"] code,
    [class*="st-key-assistant_msg_"] pre code {{
        background: transparent !important;
        color: #E2E8F0 !important;
        font-family: "JetBrains Mono", "Fira Code", Consolas, monospace !important;
        font-size: 0.86rem !important;
        line-height: 1.65 !important;
    }}

    [data-testid="stCode"].glass-code-enhanced [data-testid="stCodeCopyButton"],
    [data-testid="stCode"].glass-code-enhanced button[title*="Copy"] {{
        display: none !important;
    }}

    .glass-code-header {{
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 7px 14px;
        background: rgba(255, 255, 255, 0.04);
        border-bottom: 1px solid rgba(148, 163, 184, 0.12);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}

    .glass-code-lang {{
        font-size: 0.72rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #94A3B8;
    }}

    .glass-code-copy-btn {{
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 10px;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(255, 255, 255, 0.05);
        color: #CBD5E1;
        font-size: 0.74rem;
        cursor: pointer;
        transition: all 0.16s ease;
    }}

    .glass-code-copy-btn:hover {{
        color: #F8FAFC;
        border-color: rgba(129, 140, 248, 0.45);
        background: rgba(99, 102, 241, 0.18);
    }}

    .glass-code-copy-btn.copied {{
        color: #34D399;
        border-color: rgba(52, 211, 153, 0.45);
        background: rgba(16, 185, 129, 0.12);
    }}

    /* ===== 底部悬浮圆角胶囊输入框 ===== */
    [data-testid="stBottom"] {{
        background: var(--bottom-fade) !important;
        padding: 12px 16px 20px 16px !important;
    }}

    [data-testid="stBottom"] > div {{
        background: transparent !important;
        max-width: 768px !important;
        margin: 0 auto !important;
        padding: 0 !important;
    }}

    [data-testid="stChatInput"] {{
        max-width: 768px !important;
        margin: 0 auto !important;
        background: var(--input-bg) !important;
        backdrop-filter: blur(16px) !important;
        -webkit-backdrop-filter: blur(16px) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 26px !important;
        box-shadow: var(--shadow-soft) !important;
        padding: 4px 8px !important;
        transition: border-color 0.2s ease, box-shadow 0.2s ease !important;
    }}

    [data-testid="stChatInput"]:focus-within {{
        border-color: var(--glass-border-focus) !important;
        box-shadow: var(--shadow-soft), 0 0 0 3px rgba(99, 102, 241, 0.16) !important;
    }}

    [data-testid="stChatInput"] > div {{
        background: transparent !important;
        border: none !important;
    }}

    [data-testid="stChatInput"] textarea {{
        background: transparent !important;
        color: var(--text-primary) !important;
        font-size: 0.95rem !important;
        line-height: 1.55 !important;
        max-height: 180px !important;
    }}

    [data-testid="stChatInput"] textarea::placeholder {{
        color: var(--text-secondary) !important;
        opacity: 0.85 !important;
    }}

    [data-testid="stChatInputSubmitButton"] {{
        background: var(--accent) !important;
        color: #FFFFFF !important;
        border-radius: 999px !important;
        transition: opacity 0.18s ease, transform 0.18s ease !important;
    }}

    [data-testid="stChatInputSubmitButton"]:hover:not(:disabled) {{
        opacity: 0.92 !important;
        transform: scale(1.03) !important;
    }}

    /* ===== 圆形毛玻璃「回到底部」悬浮按钮 ===== */
    #glass-scroll-bottom-btn {{
        position: fixed;
        bottom: 102px;
        left: 50%;
        transform: translateX(-50%) translateY(14px);
        z-index: 980;
        width: 40px;
        height: 40px;
        border-radius: 999px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--glass-bg);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid var(--glass-border);
        box-shadow: var(--shadow-soft);
        color: var(--text-primary);
        font-size: 1.05rem;
        cursor: pointer;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.22s ease, transform 0.22s ease, border-color 0.2s ease;
    }}

    #glass-scroll-bottom-btn.visible {{
        opacity: 1;
        pointer-events: auto;
        transform: translateX(-50%) translateY(0);
    }}

    #glass-scroll-bottom-btn:hover {{
        border-color: var(--glass-border-focus);
        background: var(--glass-bg-hover);
    }}

    /* ===== 登录页毛玻璃卡片 ===== */
    .st-key-login_card {{
        background: var(--glass-bg) !important;
        backdrop-filter: blur(16px) !important;
        -webkit-backdrop-filter: blur(16px) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 22px !important;
        padding: 32px 28px 26px 28px !important;
        box-shadow: var(--shadow-soft) !important;
    }}

    .st-key-login_card [data-testid="stForm"] {{
        border: none !important;
        padding: 0 !important;
        background: transparent !important;
    }}

    .st-key-login_card input[type="password"] {{
        background: var(--input-bg) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 12px !important;
        color: var(--text-primary) !important;
    }}

    .st-key-login_card input[type="password"]:focus {{
        border-color: var(--glass-border-focus) !important;
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.16) !important;
    }}

    .st-key-login_card button[kind="primaryFormSubmit"],
    .st-key-login_card button[kind="primary"] {{
        background: var(--accent) !important;
        border: none !important;
        border-radius: 12px !important;
        color: #FFFFFF !important;
        font-weight: 600 !important;
        height: 42px !important;
    }}

    .thinking-pulse {{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text-secondary);
        font-size: 0.90rem;
        padding: 4px 0;
        animation: glassPulse 1.6s ease-in-out infinite;
    }}

    @keyframes glassPulse {{
        0%, 100% {{ opacity: 0.55; }}
        50% {{ opacity: 1; }}
    }}
    </style>
    """
    st.markdown(css, unsafe_allow_html=True)


def inject_ui_enhancer(is_streaming: bool) -> None:
    """
    注入轻量级同源 DOM 交互增强器：
    1. 为每条 AI 回复的悬停操作栏渲染一键「复制」按钮及成功反馈
    2. 为每个代码块添加顶部语言标签与一键复制成功状态反馈
    3. 监听主滚动区：向上翻看历史时停止自动滚底并浮现圆形毛玻璃「回到底部」按钮
    """
    streaming_flag = "true" if is_streaming else "false"
    script = f"""
    <script>
    (function() {{
        try {{
            const parentWin = window.parent;
            const doc = parentWin.document;
            if (!doc) return;

            parentWin.__glassIsStreaming = {streaming_flag};

            function decodeBase64Utf8(b64) {{
                const binary = atob(b64);
                const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
                return new TextDecoder("utf-8").decode(bytes);
            }}

            async function copyText(text) {{
                try {{
                    if (parentWin.navigator && parentWin.navigator.clipboard && parentWin.navigator.clipboard.writeText) {{
                        await parentWin.navigator.clipboard.writeText(text);
                        return true;
                    }}
                }} catch (_) {{}}
                const ta = doc.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                doc.body.appendChild(ta);
                ta.focus();
                ta.select();
                let ok = false;
                try {{ ok = doc.execCommand("copy"); }} catch (_) {{}}
                doc.body.removeChild(ta);
                return ok;
            }}

            function enhanceReplyCopyButtons() {{
                const anchors = doc.querySelectorAll(".ai-copy-anchor[data-copy-b64]");
                anchors.forEach((anchor) => {{
                    if (anchor.dataset.bound === "1") return;
                    anchor.dataset.bound = "1";
                    const btn = doc.createElement("button");
                    btn.type = "button";
                    btn.className = "glass-action-btn";
                    btn.innerHTML = "<span>📋</span><span>复制</span>";
                    btn.addEventListener("click", async () => {{
                        const raw = decodeBase64Utf8(anchor.dataset.copyB64 || "");
                        const ok = await copyText(raw);
                        if (ok) {{
                            btn.classList.add("copied");
                            btn.innerHTML = "<span>✓</span><span>已复制</span>";
                            setTimeout(() => {{
                                btn.classList.remove("copied");
                                btn.innerHTML = "<span>📋</span><span>复制</span>";
                            }}, 1800);
                        }}
                    }});
                    anchor.innerHTML = "";
                    anchor.appendChild(btn);
                }});
            }}

            function detectLanguage(codeEl) {{
                if (!codeEl) return "CODE";
                const cls = codeEl.className || "";
                const match = cls.match(/language-([a-zA-Z0-9_+#-]+)/i);
                if (match && match[1]) return match[1].toUpperCase();
                return "CODE";
            }}

            function enhanceCodeBlocks() {{
                const blocks = doc.querySelectorAll('[data-testid="stCode"]');
                blocks.forEach((block) => {{
                    if (block.classList.contains("glass-code-enhanced")) return;
                    const codeEl = block.querySelector("pre code") || block.querySelector("pre");
                    if (!codeEl) return;

                    block.classList.add("glass-code-enhanced");
                    const header = doc.createElement("div");
                    header.className = "glass-code-header";

                    const lang = doc.createElement("span");
                    lang.className = "glass-code-lang";
                    lang.textContent = detectLanguage(codeEl);

                    const copyBtn = doc.createElement("button");
                    copyBtn.type = "button";
                    copyBtn.className = "glass-code-copy-btn";
                    copyBtn.innerHTML = "<span>复制</span>";
                    copyBtn.addEventListener("click", async () => {{
                        const ok = await copyText(codeEl.innerText || codeEl.textContent || "");
                        if (ok) {{
                            copyBtn.classList.add("copied");
                            copyBtn.innerHTML = "<span>✓ 已复制</span>";
                            setTimeout(() => {{
                                copyBtn.classList.remove("copied");
                                copyBtn.innerHTML = "<span>复制</span>";
                            }}, 1800);
                        }}
                    }});

                    header.appendChild(lang);
                    header.appendChild(copyBtn);
                    block.insertBefore(header, block.firstChild);
                }});
            }}

            function getScrollContainer() {{
                return (
                    doc.querySelector("section.stMain") ||
                    doc.querySelector('[data-testid="stAppViewContainer"] > section.main') ||
                    doc.scrollingElement
                );
            }}

            function setupSmartScroll() {{
                const scroller = getScrollContainer();
                if (!scroller) return;

                let btn = doc.getElementById("glass-scroll-bottom-btn");
                if (!btn) {{
                    btn = doc.createElement("button");
                    btn.id = "glass-scroll-bottom-btn";
                    btn.type = "button";
                    btn.title = "回到底部";
                    btn.setAttribute("aria-label", "回到底部");
                    btn.innerHTML = "↓";
                    doc.body.appendChild(btn);
                }}

                if (!btn.dataset.bound) {{
                    btn.dataset.bound = "1";
                    btn.addEventListener("click", () => {{
                        const s = getScrollContainer();
                        if (!s) return;
                        parentWin.__glassUserScrolledUp = false;
                        s.scrollTo({{ top: s.scrollHeight, behavior: "smooth" }});
                    }});
                }}

                const updateScrollState = () => {{
                    const s = getScrollContainer();
                    if (!s) return;
                    const distFromBottom = s.scrollHeight - s.scrollTop - s.clientHeight;
                    const scrolledUp = distFromBottom > 140;
                    parentWin.__glassUserScrolledUp = scrolledUp;
                    if (scrolledUp) {{
                        btn.classList.add("visible");
                    }} else {{
                        btn.classList.remove("visible");
                    }}
                }};

                if (!scroller.dataset.glassScrollBound) {{
                    scroller.dataset.glassScrollBound = "1";
                    scroller.addEventListener("scroll", updateScrollState, {{ passive: true }});
                }}

                if (parentWin.__glassIsStreaming && !parentWin.__glassUserScrolledUp) {{
                    scroller.scrollTop = scroller.scrollHeight;
                }}
                updateScrollState();
            }}

            function runAll() {{
                enhanceReplyCopyButtons();
                enhanceCodeBlocks();
                setupSmartScroll();
            }}

            runAll();

            if (!parentWin.__glassObserver) {{
                const observer = new MutationObserver(() => {{
                    runAll();
                }});
                observer.observe(doc.body, {{ childList: true, subtree: true }});
                parentWin.__glassObserver = observer;
            }}
        }} catch (_) {{}}
    }})();
    </script>
    """
    components.html(script, height=0, width=0)


# ==============================================================================
# 安全检查与登录门禁
# ==============================================================================


def ensure_env_configured(config: dict[str, Any]) -> None:
    """启动兜底校验：确保关键 Secrets 已配置且非空，防止空密码绕过。"""
    missing: list[str] = []
    if not config["api_key"]:
        missing.append("GEMINI_API_KEY")
    if not config["access_password"]:
        missing.append("ACCESS_PASSWORD")

    if missing:
        st.markdown("<div style='height: 12vh;'></div>", unsafe_allow_html=True)
        _, center_col, _ = st.columns([1, 1.8, 1])
        with center_col:
            with st.container(key="login_card"):
                st.markdown(
                    "<div class='nav-brand' style='margin-bottom:12px;'>"
                    "<span class='starburst-icon'></span>"
                    "<span class='nav-title' style='font-size:1.15rem;'>服务尚未完成初始化配置</span>"
                    "</div>",
                    unsafe_allow_html=True,
                )
                st.error(
                    f"缺少必要的环境变量：`{'`、`'.join(missing)}`。"
                    "为确保安全，应用已阻断访问。"
                )
                st.info(
                    "请联系管理员前往 **Streamlit Community Cloud（App settings → Secrets）** "
                    "或云端托管平台的环境变量 / Secrets 面板中配置上述密钥并重启应用；"
                    "若在本地运行，请在启动前设置对应环境变量或创建 `.streamlit/secrets.toml`。"
                )
        st.stop()


def ensure_authenticated(access_password: str) -> None:
    """登录门禁：未通过验证时仅渲染居中毛玻璃登录卡片并彻底阻断主界面。"""
    if st.session_state.get("authenticated", False):
        return

    st.markdown("<div style='height: 14vh;'></div>", unsafe_allow_html=True)
    _, center_col, _ = st.columns([1, 1.35, 1])

    with center_col:
        with st.container(key="login_card"):
            st.markdown(
                """
                <div style="text-align:center; margin-bottom: 20px;">
                    <div class="welcome-badge" style="width:48px; height:48px; margin-bottom:12px;">
                        <span class="starburst-icon" style="width:24px; height:24px;"></span>
                    </div>
                    <h3 style="margin:0 0 6px 0; font-size:1.25rem; font-weight:650; color:var(--text-primary);">
                        星芒 AI 登录
                    </h3>
                    <p style="margin:0; font-size:0.86rem; color:var(--text-secondary);">
                        请输入访问密码，进入日常聊天
                    </p>
                </div>
                """,
                unsafe_allow_html=True,
            )

            with st.form("login_form", clear_on_submit=False):
                password_input = st.text_input(
                    "访问密码",
                    type="password",
                    placeholder="请输入访问密码",
                    autocomplete="current-password",
                    label_visibility="collapsed",
                )
                submitted = st.form_submit_button(
                    "进入对话",
                    use_container_width=True,
                    type="primary",
                )

            if submitted:
                is_valid = hmac.compare_digest(
                    password_input.encode("utf-8"),
                    access_password.encode("utf-8"),
                )
                if is_valid:
                    st.session_state.authenticated = True
                    st.session_state.last_error = None
                    st.rerun()
                else:
                    time.sleep(1)
                    st.error("访问密码错误，请重新输入。")

    st.stop()


# ==============================================================================
# 多模态图片预处理、消息构造与异常处理
# ==============================================================================


def process_uploaded_image(uploaded_file: Any) -> str:
    """
    使用 Pillow 预处理上传图片，返回压缩后的 JPEG Base64 字符串：
    1. 修正 EXIF 拍摄方向
    2. 对含透明或调色板通道的图片合成白底并转为 RGB
    3. 长边等比缩放至 1024px 以内
    4. 编码为 JPEG（质量 80）并转为 Base64
    """
    raw_bytes = uploaded_file.getvalue()
    with Image.open(io.BytesIO(raw_bytes)) as img:
        img = ImageOps.exif_transpose(img)

        if img.mode in ("RGBA", "LA", "PA", "P"):
            img_rgba = img.convert("RGBA")
            white_bg = Image.new("RGB", img_rgba.size, (255, 255, 255))
            white_bg.paste(img_rgba, mask=img_rgba.getchannel("A"))
            img = white_bg
        elif img.mode != "RGB":
            img = img.convert("RGB")

        img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)

        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        jpeg_bytes = buffer.getvalue()

    return base64.b64encode(jpeg_bytes).decode("utf-8")


def build_api_messages(
    history: list[dict[str, Any]],
    context_turns: int = DEFAULT_CONTEXT_TURNS,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
) -> list[dict[str, Any]]:
    """
    构建发送给模型的 OpenAI 兼容 messages 列表：
    - 头部附带日常对话 System Prompt
    - 仅截取最近 N 轮对话发送，且确保窗口起点为 user 消息
    - 单轮传图策略：仅在当前最新一轮 user 消息中附带图片 Base64
    """
    api_messages: list[dict[str, Any]] = []

    cleaned_system = system_prompt.strip()
    if cleaned_system:
        api_messages.append({"role": "system", "content": cleaned_system})

    max_window_messages = context_turns * 2
    window_messages = list(history[-max_window_messages:])
    while window_messages and window_messages[0].get("role") != "user":
        window_messages.pop(0)

    last_index = len(window_messages) - 1
    for idx, msg in enumerate(window_messages):
        role = msg["role"]
        text_content = msg.get("content", "")
        image_b64 = msg.get("image_b64")
        is_current_turn = idx == last_index and role == "user"

        if is_current_turn and image_b64:
            prompt_text = text_content.strip() or "请帮我看看这张图片。"
            api_messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt_text},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_b64}"
                            },
                        },
                    ],
                }
            )
        else:
            if role == "user" and not text_content.strip() and image_b64:
                fallback_text = "[用户此前发了一张图片]"
            else:
                fallback_text = text_content
            api_messages.append({"role": role, "content": fallback_text})

    return api_messages


def format_api_error(exc: Exception) -> str:
    """将底层异常转换为友好的中文提示。"""
    if isinstance(exc, AuthenticationError):
        return "❌ 服务密钥无效或已过期，请联系管理员检查配置。"
    if isinstance(exc, PermissionDeniedError):
        return "❌ 当前密钥无权访问服务，请联系管理员核查权限。"
    if isinstance(exc, NotFoundError):
        return "❌ 服务模型或接口地址配置异常，请联系管理员检查。"
    if isinstance(exc, RateLimitError):
        return "⏳ 当前对话人数较多或请求太快，请稍等几秒再试。"
    if isinstance(exc, APITimeoutError):
        return "⌛ 响应有点慢超时了，请再试一次。"
    if isinstance(exc, APIConnectionError):
        return "🌐 网络连接暂时不稳定，请稍后重试。"
    if isinstance(exc, BadRequestError):
        return "⚠️ 这条内容或图片格式无法处理，请换种说法或换张图片试试。"
    if isinstance(exc, APIStatusError):
        return "⚠️ 服务暂时开小差了，请稍后重试。"
    return "⚠️ 回复时出了点小状况，请稍后重试。"


def clear_conversation() -> None:
    """清空当前对话记录。"""
    st.session_state.messages = []
    st.session_state.last_error = None


def submit_user_message(user_text: str, image_b64: str | None = None) -> None:
    """写入用户消息并置位生成锁，随后 rerun 开始流式输出。"""
    st.session_state.messages.append(
        {
            "role": "user",
            "content": user_text,
            "image_b64": image_b64,
        }
    )
    st.session_state.last_error = None
    st.session_state.is_generating = True
    st.session_state.pending_generation = True
    st.rerun()


# ==============================================================================
# 顶部毛玻璃导航栏、欢迎态、聊天区与流式输出
# ==============================================================================


def render_top_navbar() -> None:
    """渲染 56px 顶部固定毛玻璃导航栏：极简星芒 Logo + 标题 + 明暗切换 / 清空 / 退出按钮。"""
    is_busy = st.session_state.is_generating
    is_dark = st.session_state.theme_mode == "dark"

    with st.container(key="top_navbar"):
        brand_col, spacer_col, theme_col, clear_col, logout_col = st.columns(
            [0.36, 0.43, 0.07, 0.07, 0.07],
            vertical_alignment="center",
        )
        with brand_col:
            st.markdown(
                "<div class='nav-brand'>"
                "<span class='starburst-icon'></span>"
                "<span class='nav-title'>星芒 AI</span>"
                "</div>",
                unsafe_allow_html=True,
            )
        with spacer_col:
            st.empty()
        with theme_col:
            if st.button(
                "☀️" if is_dark else "🌙",
                key="theme_toggle_btn",
                help="切换浅色模式" if is_dark else "切换深色模式",
                disabled=is_busy,
            ):
                st.session_state.theme_mode = "light" if is_dark else "dark"
                st.rerun()
        with clear_col:
            if st.button(
                "🗑️",
                key="nav_clear_btn",
                help="清空当前对话",
                disabled=is_busy or not st.session_state.messages,
            ):
                clear_conversation()
                st.rerun()
        with logout_col:
            if st.button(
                "🚪",
                key="nav_logout_btn",
                help="退出登录",
                disabled=is_busy,
            ):
                st.session_state.authenticated = False
                st.session_state.is_generating = False
                st.session_state.pending_generation = False
                st.session_state.last_error = None
                st.rerun()


def render_welcome_state() -> None:
    """无消息时展示居中欢迎语 + 4 张毛玻璃日常快捷提问卡片。"""
    st.markdown(
        """
        <div class="welcome-hero">
            <div class="welcome-badge">
                <span class="starburst-icon"></span>
            </div>
            <h1 class="welcome-title">嗨，今天想聊点什么？</h1>
            <p class="welcome-subtitle">
                日常聊天、查点生活灵感、润色文字，或者直接发张照片让我看看
            </p>
        </div>
        """,
        unsafe_allow_html=True,
    )

    is_busy = st.session_state.is_generating
    for row_start in (0, 2):
        col_left, col_right = st.columns(2, gap="medium")
        for offset, col in enumerate((col_left, col_right)):
            card_idx = row_start + offset
            card = QUICK_PROMPTS[card_idx]
            with col:
                with st.container(key=f"quick_card_{card_idx}"):
                    label = f"**{card['title']}**\n{card['desc']}"
                    if st.button(
                        label,
                        key=f"quick_btn_{card_idx}",
                        use_container_width=True,
                        disabled=is_busy,
                    ):
                        submit_user_message(card["prompt"], None)


def render_chat_history() -> None:
    """渲染全部历史对话消息，用户右对齐靛蓝气泡、AI 左对齐文档流与悬停操作栏。"""
    messages = st.session_state.messages
    if not messages:
        render_welcome_state()
        return

    total = len(messages)
    is_busy = st.session_state.is_generating

    for idx, msg in enumerate(messages):
        role = msg["role"]
        if role == "user":
            with st.container(key=f"user_msg_{idx}"):
                with st.container(key=f"user_bubble_{idx}"):
                    image_b64 = msg.get("image_b64")
                    if image_b64:
                        st.image(base64.b64decode(image_b64), width=320)
                    if msg.get("content"):
                        st.markdown(msg["content"])
                    elif image_b64:
                        st.caption("（已发送图片）")
        else:
            is_last_assistant = idx == total - 1
            reply_text = msg.get("content", "")
            copy_b64 = base64.b64encode(reply_text.encode("utf-8")).decode("ascii")

            with st.container(key=f"assistant_msg_{idx}"):
                st.markdown(
                    "<div class='ai-header'>"
                    "<span class='starburst-icon'></span>"
                    "<span class='ai-header-label'>星芒 AI</span>"
                    "</div>",
                    unsafe_allow_html=True,
                )
                st.markdown(reply_text)

                # 悬停平滑显示「复制」「重新生成」
                with st.container(key=f"msg_actions_{idx}"):
                    if is_last_assistant and not is_busy:
                        copy_col, regen_col, _ = st.columns([0.14, 0.19, 0.67])
                        with copy_col:
                            st.markdown(
                                f"<div class='ai-copy-anchor' data-copy-b64='{copy_b64}'></div>",
                                unsafe_allow_html=True,
                            )
                        with regen_col:
                            if st.button(
                                "↻ 重新生成",
                                key="regenerate_btn",
                                disabled=is_busy,
                                help="换一种说法重新回答",
                            ):
                                if (
                                    not st.session_state.is_generating
                                    and st.session_state.messages
                                    and st.session_state.messages[-1]["role"] == "assistant"
                                ):
                                    st.session_state.messages.pop()
                                    st.session_state.last_error = None
                                    st.session_state.is_generating = True
                                    st.session_state.pending_generation = True
                                    st.rerun()
                    else:
                        st.markdown(
                            f"<div class='ai-copy-anchor' data-copy-b64='{copy_b64}'></div>",
                            unsafe_allow_html=True,
                        )

    if (
        not is_busy
        and messages[-1]["role"] == "user"
        and not st.session_state.pending_generation
    ):
        if st.button(
            "↻ 重试生成",
            key="retry_btn",
            disabled=is_busy,
            help="重新发送上一条提问",
        ):
            if not st.session_state.is_generating and st.session_state.messages:
                st.session_state.last_error = None
                st.session_state.is_generating = True
                st.session_state.pending_generation = True
                st.rerun()


def stream_assistant_response(config: dict[str, Any]) -> None:
    """流式生成日常回复；异常时不写入残缺内容，并在 finally 释放生成锁。"""
    error_message: str | None = None

    with st.container(key="assistant_msg_streaming"):
        st.markdown(
            "<div class='ai-header'>"
            "<span class='starburst-icon'></span>"
            "<span class='ai-header-label'>星芒 AI</span>"
            "</div>",
            unsafe_allow_html=True,
        )
        loading_placeholder = st.empty()
        loading_placeholder.markdown(
            "<div class='thinking-pulse'>✦ 正在回复中...</div>",
            unsafe_allow_html=True,
        )
        content_placeholder = st.empty()

        content_parts: list[str] = []
        first_content_received = False

        try:
            client = get_openai_client(config["api_key"], config["base_url"])
            api_messages = build_api_messages(history=st.session_state.messages)

            request_kwargs: dict[str, Any] = {
                "model": config["model_name"],
                "messages": api_messages,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "stream": True,
            }
            if config["reasoning_effort"] is not None:
                request_kwargs["reasoning_effort"] = config["reasoning_effort"]

            stream = client.chat.completions.create(**request_kwargs)

            for chunk in stream:
                choices = getattr(chunk, "choices", None)
                if not choices:
                    continue

                delta = getattr(choices[0], "delta", None)
                if delta is None:
                    continue

                content_piece = getattr(delta, "content", None)
                if content_piece:
                    if not first_content_received:
                        first_content_received = True
                        loading_placeholder.empty()
                    content_parts.append(content_piece)
                    content_placeholder.markdown("".join(content_parts) + "▌")

            loading_placeholder.empty()
            full_reply = "".join(content_parts)

            if not full_reply.strip():
                error_message = "⚠️ 刚才没有收到完整回复，请换个说法再试一次。"
            else:
                content_placeholder.markdown(full_reply)
                st.session_state.messages.append(
                    {
                        "role": "assistant",
                        "content": full_reply,
                    }
                )

        except Exception as exc:  # noqa: BLE001
            loading_placeholder.empty()
            error_message = format_api_error(exc)
        finally:
            st.session_state.is_generating = False
            st.session_state.pending_generation = False

    st.session_state.last_error = error_message
    st.rerun()


def handle_chat_input() -> None:
    """渲染底部悬浮圆角胶囊输入框（支持发文字与发图）。"""
    prompt = st.chat_input(
        placeholder="说点什么，或点左侧回形针发张图片...",
        accept_file=True,
        file_type=["png", "jpg", "jpeg", "webp"],
        max_chars=MAX_INPUT_CHARS,
        disabled=st.session_state.is_generating,
    )

    if prompt is None or st.session_state.is_generating:
        return

    user_text = (prompt.text or "").strip()
    uploaded_files = list(prompt.files or [])

    if not user_text and not uploaded_files:
        st.warning("请输入内容或上传一张图片后再发送。")
        return

    if len(user_text) > MAX_INPUT_CHARS:
        st.warning(
            f"单次输入长度不能超过 {MAX_INPUT_CHARS:,} 个字符，请精简后再发送。"
        )
        return

    image_b64: str | None = None
    if uploaded_files:
        try:
            image_b64 = process_uploaded_image(uploaded_files[0])
        except (UnidentifiedImageError, OSError, ValueError):
            st.error("图片解析失败，请确认上传的是有效的 PNG / JPG / WebP 图片。")
            return

    submit_user_message(user_text, image_b64)


# ==============================================================================
# 主入口
# ==============================================================================


def main() -> None:
    st.set_page_config(
        page_title="星芒 AI · 日常聊天",
        page_icon="✦",
        layout="wide",
        initial_sidebar_state="collapsed",
    )

    config = load_config()
    init_session_state()
    inject_glass_theme_css(st.session_state.theme_mode)

    # 1. 启动密钥校验
    ensure_env_configured(config)

    # 2. 访问密码门禁
    ensure_authenticated(config["access_password"])

    # 3. 56px 顶部固定毛玻璃导航栏
    render_top_navbar()

    # 4. 768px 居中聊天区
    with st.container(key="chat_stage"):
        render_chat_history()

        if st.session_state.last_error:
            st.error(st.session_state.last_error)

        if st.session_state.pending_generation:
            stream_assistant_response(config)

    # 5. 底部悬浮胶囊输入框 + 客户端交互增强
    handle_chat_input()
    inject_ui_enhancer(is_streaming=st.session_state.pending_generation)


if __name__ == "__main__":
    main()
