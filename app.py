"""
Gemini 4 Hydrogen 小圈子轻量级 AI 对话应用（Streamlit + OpenAI 兼容端点）

视觉与交互规范：「深邃毛玻璃风」
- 默认深色模式（#090C14 + 靛蓝/青蓝低饱和径向光晕），支持顶部一键切换浅色/深色模式。
- 56px 顶部固定毛玻璃导航栏：极简星芒 Logo、标题、模型选择胶囊、明暗切换与清空对话按钮。
- 768px 居中对话区：空状态展示欢迎语 + 4 张毛玻璃快捷提问卡片。
- 用户消息右对齐半透明靛蓝圆角气泡；AI 回复去边框文档流左对齐，悬停平滑显示「复制」「重新生成」。
- #141720 深色圆角代码块卡片，带顶部语言标签与一键复制成功反馈。
- 底部悬浮圆角胶囊输入框 + 向上翻看历史时停止自动滚底并浮现圆形毛玻璃「回到底部」按钮。

安全与成本控制：
- 零硬编码密钥；兼容环境变量与 Streamlit Secrets；登录门禁 + hmac 常量时间比对 + 防爆破延迟。
- 滑动窗口截断（2–12 轮，默认 6 轮）、单轮传图压缩（<=1024px JPEG 80）、输入 12,000 字/输出 4,096 token 上限。
"""

from __future__ import annotations

import base64
from datetime import datetime
import hmac
import html
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
# 全局常量配置
# ==============================================================================

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_MODEL_NAME = "gemini-4-hydrogen"
DEFAULT_REASONING_EFFORT = "low"

# 导航栏模型选择胶囊候选项（默认始终优先选中 config["model_name"]）
AVAILABLE_MODELS: list[str] = [
    "gemini-4-hydrogen",
    "gemini-4-argon",
    "gemini-4-neon",
]

# 成本与稳定性兜底阈值
MAX_INPUT_CHARS = 12000
MAX_OUTPUT_TOKENS = 4096
MAX_IMAGE_SIDE = 1024
JPEG_QUALITY = 80
API_TIMEOUT_SECONDS = 60.0
API_MAX_RETRIES = 1

# 滑动窗口轮数配置
MIN_CONTEXT_TURNS = 2
MAX_CONTEXT_TURNS = 12
DEFAULT_CONTEXT_TURNS = 6

# System Prompt 快捷预设（不会写入对话历史，每次请求动态拼接至头部）
SYSTEM_PRESETS: dict[str, str] = {
    "默认助手": "你是一位专业、友善、表达清晰简洁的中文 AI 助手。请直接给出准确、有条理的回答。",
    "翻译润色": (
        "你是一位精通中英文的专业翻译与文字编辑。请准确传达原意，兼顾地道表达与语境自然度；"
        "若用户要求润色，请保留核心观点并给出清晰优化后的版本。"
    ),
    "代码助手": (
        "你是一位资深全栈软件工程师。请优先提供简洁、健壮、可直接运行的代码方案，"
        "并在关键位置附带简明注释，指出潜在边界条件与性能注意事项。"
    ),
    "自定义": "",
}

# 空状态 4 张毛玻璃快捷提问卡片
QUICK_PROMPTS: list[dict[str, str]] = [
    {
        "title": "✦ 深度概念拆解",
        "desc": "用通俗比喻讲清 Transformer 注意力机制与核心直觉",
        "prompt": "请用通俗易懂的比喻解释 Transformer 的注意力机制，并举一个贴近日常生活的例子帮助理解。",
    },
    {
        "title": "</> 健壮代码实战",
        "desc": "生成带并发限制、超时与自动重试的 Python 异步请求模板",
        "prompt": "请帮我写一段生产可用的 Python 异步批量 HTTP 请求代码，包含并发数限制、超时控制与指数退避重试，并附简明注释。",
    },
    {
        "title": "✎ 地道中英润色",
        "desc": "将中文工作沟通句转化为 3 种不同语气的自然英文表达",
        "prompt": "请把“这个方案目前还有几个细节待确认，我们周三前同步最终版本”翻译并润色为：正式商务、友好同事、简短即时通讯 3 种地道英文版本。",
    },
    {
        "title": "◈ 团队效率方案",
        "desc": "为 10 人以内小团队设计轻量高效的周报与 AI 协作流",
        "prompt": "请为一个 10 人以内的小团队设计一套轻量级周报模板与日常 AI 提效工作流，要求简洁好落地、不增加负担。",
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
    """从环境变量或 Streamlit Secrets 读取全部运行配置，杜绝硬编码敏感信息。"""
    api_key = (get_config_value("GEMINI_API_KEY") or "").strip()
    access_password = (get_config_value("ACCESS_PASSWORD") or "").strip()
    base_url = (get_config_value("BASE_URL") or "").strip() or DEFAULT_BASE_URL
    model_name = (get_config_value("MODEL_NAME") or "").strip() or DEFAULT_MODEL_NAME

    # 思考深度控制：
    # - 未配置时，默认使用 "low"
    # - 显式置空（如 REASONING_EFFORT=""）时，请求不传该字段，提升切换模型兼容性
    # - Gemini 4 不支持 "none"，若误配为 "none" 则同样不传该字段
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


def get_model_options(default_model: str) -> list[str]:
    """生成去重后的模型胶囊选项列表，始终将默认模型放在首位。"""
    options: list[str] = [default_model]
    for model in AVAILABLE_MODELS:
        if model not in options:
            options.append(model)
    return options


def init_session_state(default_model: str) -> None:
    """初始化会话级状态变量。"""
    defaults: dict[str, Any] = {
        "authenticated": False,
        "theme_mode": "dark",  # 默认深色模式，支持顶部一键切换 dark / light
        "selected_model": default_model,
        "messages": [],
        "is_generating": False,
        "pending_generation": False,
        "last_error": None,
        "context_turns": DEFAULT_CONTEXT_TURNS,
        "system_preset": "默认助手",
        "system_prompt": SYSTEM_PRESETS["默认助手"],
        "last_prompt_tokens": 0,
        "last_completion_tokens": 0,
        "total_prompt_tokens": 0,
        "total_completion_tokens": 0,
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
            "sidebar_bg": "rgba(13, 18, 31, 0.86)",
            "input_bg": "rgba(20, 26, 42, 0.74)",
            "bottom_fade": "linear-gradient(to top, rgba(9, 12, 20, 0.96) 58%, rgba(9, 12, 20, 0) 100%)",
            "shadow_soft": "0 14px 36px rgba(0, 0, 0, 0.45)",
            "shadow_card": "0 8px 28px rgba(0, 0, 0, 0.28)",
            "popover_bg": "#111726",
            "pill_bg": "rgba(99, 102, 241, 0.14)",
            "action_hover_bg": "rgba(148, 163, 184, 0.12)",
            "divider": "rgba(148, 163, 184, 0.14)",
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
            "sidebar_bg": "rgba(248, 250, 255, 0.90)",
            "input_bg": "rgba(255, 255, 255, 0.84)",
            "bottom_fade": "linear-gradient(to top, rgba(243, 246, 252, 0.97) 58%, rgba(243, 246, 252, 0) 100%)",
            "shadow_soft": "0 12px 32px rgba(15, 23, 42, 0.10)",
            "shadow_card": "0 8px 24px rgba(15, 23, 42, 0.06)",
            "popover_bg": "#FFFFFF",
            "pill_bg": "rgba(99, 102, 241, 0.10)",
            "action_hover_bg": "rgba(15, 23, 42, 0.06)",
            "divider": "rgba(15, 23, 42, 0.10)",
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
        --sidebar-bg: {tokens["sidebar_bg"]};
        --input-bg: {tokens["input_bg"]};
        --bottom-fade: {tokens["bottom_fade"]};
        --shadow-soft: {tokens["shadow_soft"]};
        --shadow-card: {tokens["shadow_card"]};
        --popover-bg: {tokens["popover_bg"]};
        --pill-bg: {tokens["pill_bg"]};
        --action-hover-bg: {tokens["action_hover_bg"]};
        --divider: {tokens["divider"]};
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

    /* 隐藏默认顶部装饰条与页脚水印，同时保留侧边栏展开按钮 */
    [data-testid="stDecoration"],
    #MainMenu,
    footer {{
        display: none !important;
    }}

    header[data-testid="stHeader"] {{
        background: transparent !important;
        height: 0 !important;
        min-height: 0 !important;
        overflow: visible !important;
        pointer-events: none !important;
    }}

    header[data-testid="stHeader"] [data-testid="stToolbar"] {{
        display: none !important;
    }}

    header[data-testid="stHeader"] [data-testid="stExpandSidebarButton"],
    header[data-testid="stHeader"] button[kind="headerNoPadding"] {{
        pointer-events: auto !important;
        position: fixed !important;
        top: 10px !important;
        left: 12px !important;
        z-index: 1050 !important;
        width: 36px !important;
        height: 36px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: var(--glass-bg) !important;
        backdrop-filter: blur(16px) !important;
        -webkit-backdrop-filter: blur(16px) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 10px !important;
        color: var(--text-primary) !important;
        transition: border-color 0.2s ease, background 0.2s ease !important;
    }}

    header[data-testid="stHeader"] [data-testid="stExpandSidebarButton"]:hover {{
        border-color: var(--glass-border-focus) !important;
        background: var(--glass-bg-hover) !important;
    }}

    /* 主容器去除多余边距，让顶部导航栏全宽贴顶 */
    .stMainBlockContainer,
    [data-testid="stMainBlockContainer"] {{
        max-width: 100% !important;
        padding: 0 !important;
    }}

    /* 隐藏零高度 JS 增强 iframe 占位 */
    iframe[height="0"] {{
        display: block !important;
        height: 0 !important;
        min-height: 0 !important;
        border: none !important;
        margin: 0 !important;
        padding: 0 !important;
    }}

    /* ===== 侧边栏毛玻璃样式 ===== */
    section[data-testid="stSidebar"] {{
        background: var(--sidebar-bg) !important;
        backdrop-filter: blur(18px) !important;
        -webkit-backdrop-filter: blur(18px) !important;
        border-right: 1px solid var(--glass-border) !important;
    }}

    section[data-testid="stSidebar"] * {{
        color: var(--text-primary);
    }}

    section[data-testid="stSidebar"] [data-testid="stMetricValue"] {{
        font-size: 1.25rem !important;
        font-weight: 600 !important;
        color: var(--text-primary) !important;
    }}

    section[data-testid="stSidebar"] [data-testid="stMetricLabel"],
    section[data-testid="stSidebar"] [data-testid="stCaptionContainer"] p {{
        color: var(--text-secondary) !important;
    }}

    section[data-testid="stSidebar"] textarea,
    section[data-testid="stSidebar"] [data-baseweb="select"] > div {{
        background: var(--glass-bg) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 12px !important;
        color: var(--text-primary) !important;
    }}

    section[data-testid="stSidebar"] textarea:focus,
    section[data-testid="stSidebar"] [data-baseweb="select"] > div:focus-within {{
        border-color: var(--glass-border-focus) !important;
    }}

    section[data-testid="stSidebar"] button {{
        background: var(--glass-bg) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 12px !important;
        color: var(--text-primary) !important;
        transition: border-color 0.2s ease, background 0.2s ease !important;
    }}

    section[data-testid="stSidebar"] button:hover:not(:disabled) {{
        border-color: var(--glass-border-focus) !important;
        background: var(--glass-bg-hover) !important;
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
        padding: 0 20px 0 58px !important;
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
        gap: 0.5rem !important;
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
        font-size: 0.96rem;
        font-weight: 650;
        letter-spacing: 0.01em;
        color: var(--text-primary);
        white-space: nowrap;
    }}

    /* 导航栏模型选择胶囊 */
    .st-key-nav_model_select [data-baseweb="select"] > div {{
        min-height: 32px !important;
        height: 32px !important;
        padding: 0 10px !important;
        border-radius: 999px !important;
        background: var(--pill-bg) !important;
        border: 1px solid var(--glass-border) !important;
        color: var(--text-primary) !important;
        font-size: 0.80rem !important;
        font-weight: 500 !important;
        transition: border-color 0.2s ease, box-shadow 0.2s ease !important;
    }}

    .st-key-nav_model_select [data-baseweb="select"] > div:hover,
    .st-key-nav_model_select [data-baseweb="select"] > div:focus-within {{
        border-color: var(--glass-border-focus) !important;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.16) !important;
    }}

    .st-key-nav_model_select [data-baseweb="select"] span,
    .st-key-nav_model_select [data-baseweb="select"] svg {{
        color: var(--text-primary) !important;
        fill: var(--text-secondary) !important;
    }}

    /* 导航栏右侧图标按钮 */
    .st-key-theme_toggle_btn button,
    .st-key-nav_clear_btn button {{
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
    .st-key-nav_clear_btn button:hover:not(:disabled) {{
        background: var(--glass-bg-hover) !important;
        border-color: var(--glass-border-focus) !important;
    }}

    /* 下拉菜单浮层配色适配 */
    [data-baseweb="popover"] ul,
    [data-baseweb="menu"] {{
        background: var(--popover-bg) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 12px !important;
    }}

    [data-baseweb="menu"] li {{
        color: var(--text-primary) !important;
    }}

    [data-baseweb="menu"] li:hover {{
        background: var(--accent-soft) !important;
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
        padding: 46px 12px 30px 12px;
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
        min-height: 98px !important;
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
    /* 用户消息：半透明靛蓝圆角气泡右对齐 */
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

    /* AI 回复：去边框文档流左对齐 */
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

    /* 思考过程折叠框毛玻璃质感 */
    [class*="st-key-assistant_msg_"] [data-testid="stExpander"] {{
        background: var(--glass-bg) !important;
        backdrop-filter: blur(12px) !important;
        border: 1px solid var(--glass-border) !important;
        border-radius: 12px !important;
        margin-bottom: 12px !important;
        overflow: hidden !important;
    }}

    [class*="st-key-assistant_msg_"] [data-testid="stExpander"] summary {{
        color: var(--text-secondary) !important;
        font-size: 0.85rem !important;
    }}

    /* AI 悬停操作栏（「复制」「重新生成」） */
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

    /* 隐藏 Streamlit 默认仅悬停可见的原生代码复制按钮，交由自定义顶部栏接管 */
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

    /* 思考中微弱呼吸动画 */
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
    1. 为每条 AI 回复的悬停操作栏渲染一键「复制」按钮及成功反馈（不触发整页 rerun）
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

                // 仅在流式输出且用户未主动向上翻看历史时，柔和保持底部可见
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
        }} catch (_) {{
            // 降级静默处理，保证核心功能与纯 CSS 视觉不受影响
        }}
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
    """登录门禁：未通过验证时仅渲染居中毛玻璃登录卡片并彻底阻断主界面与侧边栏。"""
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
                        内部 AI 助手登录
                    </h3>
                    <p style="margin:0; font-size:0.86rem; color:var(--text-secondary);">
                        仅限小圈子内部成员使用，请输入访问密码继续
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

    # 关键安全屏障：未登录时立即终止渲染，杜绝侧边栏及主聊天区域暴露
    st.stop()


# ==============================================================================
# 多模态图片预处理、消息构造与导出工具
# ==============================================================================


def process_uploaded_image(uploaded_file: Any) -> str:
    """
    使用 Pillow 预处理上传图片，返回压缩后的 JPEG Base64 字符串：
    1. 修正 EXIF 拍摄方向（手机竖拍防旋转）
    2. 对 RGBA / LA / PA / P 等含透明或调色板通道的图片合成白底并转为 RGB
    3. 长边等比缩放至 1024px 以内
    4. 编码为 JPEG（质量 80）并转为 Base64，显著降低多模态 Token 与传输开销
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
    context_turns: int,
    system_prompt: str,
) -> list[dict[str, Any]]:
    """
    构建发送给模型的 OpenAI 兼容 messages 列表：
    - 动态在头部拼接 System Prompt（不污染会话历史）
    - 仅截取最近 N 轮对话发送，且确保窗口起点为 user 消息
    - 单轮传图策略：仅在当前最新一轮 user 消息中附带图片 Base64，
      历史轮次仅发送文本，防止多轮追问重复计费图片 Token
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
            prompt_text = text_content.strip() or "请查看并分析这张图片。"
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
                fallback_text = "[用户此前上传了一张图片]"
            else:
                fallback_text = text_content
            api_messages.append({"role": role, "content": fallback_text})

    return api_messages


def export_chat_to_markdown(
    messages: list[dict[str, Any]],
    model_name: str,
    system_prompt: str,
) -> str:
    """将完整对话历史导出为结构清晰的 Markdown 文本。"""
    export_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines: list[str] = [
        "# AI 对话记录导出",
        "",
        f"- **导出时间**：{export_time}",
        f"- **使用模型**：`{model_name}`",
    ]
    if system_prompt.strip():
        lines.append(f"- **当前 System Prompt**：{system_prompt.strip()}")
    lines.extend(["", "---", ""])

    for msg in messages:
        role_label = "👤 用户" if msg["role"] == "user" else "🤖 助手"
        lines.append(f"## {role_label}")
        lines.append("")

        if msg["role"] == "user" and msg.get("image_b64"):
            lines.append("*[附带 1 张图片]*")
            lines.append("")

        if msg["role"] == "assistant" and msg.get("reasoning"):
            lines.extend(
                [
                    "<details>",
                    "<summary>思考过程</summary>",
                    "",
                    msg["reasoning"].strip(),
                    "",
                    "</details>",
                    "",
                ]
            )

        content = msg.get("content", "").strip()
        if content:
            lines.append(content)
            lines.append("")

        lines.extend(["---", ""])

    return "\n".join(lines)


def format_api_error(exc: Exception) -> str:
    """将底层异常转换为友好、安全的中文错误提示，避免暴露堆栈与敏感信息。"""
    if isinstance(exc, AuthenticationError):
        return "❌ API 密钥无效或已过期（401），请联系管理员检查 `GEMINI_API_KEY` 配置。"
    if isinstance(exc, PermissionDeniedError):
        return "❌ 当前 API 密钥无权访问该模型或所在地区受限（403），请联系管理员核查权限。"
    if isinstance(exc, NotFoundError):
        return "❌ 未找到指定的模型或接口地址（404），请检查 `MODEL_NAME` 与 `BASE_URL` 配置。"
    if isinstance(exc, RateLimitError):
        return "⏳ 请求过于频繁或已触发 API 速率/配额限制（429），请稍等片刻后再试。"
    if isinstance(exc, APITimeoutError):
        return f"⌛ 请求超时（超过 {int(API_TIMEOUT_SECONDS)} 秒未响应），请稍后重试或缩短输入内容。"
    if isinstance(exc, APIConnectionError):
        return "🌐 网络连接失败，暂时无法访问 Gemini API 服务，请稍后重试。"
    if isinstance(exc, BadRequestError):
        return "⚠️ 请求参数不被接口接受（400），请尝试减少上下文轮数、精简文本或更换图片后重试。"
    if isinstance(exc, APIStatusError):
        return f"⚠️ 模型服务暂时返回异常（HTTP {exc.status_code}），请稍后重试。"
    return "⚠️ 生成回复时发生未知错误，请稍后重试。"


def clear_conversation() -> None:
    """清空对话历史并重置 Token 统计。"""
    st.session_state.messages = []
    st.session_state.last_prompt_tokens = 0
    st.session_state.last_completion_tokens = 0
    st.session_state.total_prompt_tokens = 0
    st.session_state.total_completion_tokens = 0
    st.session_state.last_error = None


def submit_user_message(user_text: str, image_b64: str | None = None) -> None:
    """写入用户消息并置位生成锁，随后 rerun 禁用交互并进入流式输出。"""
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
# 顶部毛玻璃导航栏与侧边栏控制台
# ==============================================================================


def on_preset_change() -> None:
    """切换 System Prompt 预设时同步更新文本框内容。"""
    preset_name = st.session_state.system_preset
    if preset_name != "自定义":
        st.session_state.system_prompt = SYSTEM_PRESETS[preset_name]


def on_system_prompt_edit() -> None:
    """手动编辑 System Prompt 后，如与当前预设不一致则自动切为“自定义”。"""
    preset_name = st.session_state.system_preset
    if (
        preset_name != "自定义"
        and st.session_state.system_prompt != SYSTEM_PRESETS[preset_name]
    ):
        st.session_state.system_preset = "自定义"


def render_top_navbar(config: dict[str, Any]) -> None:
    """渲染 56px 顶部固定毛玻璃导航栏：星芒 Logo、标题、模型胶囊、明暗切换、清空按钮。"""
    is_busy = st.session_state.is_generating
    is_dark = st.session_state.theme_mode == "dark"
    model_options = get_model_options(config["model_name"])
    if st.session_state.selected_model not in model_options:
        st.session_state.selected_model = config["model_name"]

    with st.container(key="top_navbar"):
        brand_col, model_col, spacer_col, theme_col, clear_col = st.columns(
            [0.24, 0.28, 0.34, 0.07, 0.07],
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
        with model_col:
            with st.container(key="nav_model_select"):
                st.selectbox(
                    "模型",
                    options=model_options,
                    key="selected_model",
                    label_visibility="collapsed",
                    disabled=is_busy,
                )
        with spacer_col:
            st.empty()
        with theme_col:
            if st.button(
                "☀️" if is_dark else "🌙",
                key="theme_toggle_btn",
                help="切换到浅色模式" if is_dark else "切换到深色模式",
                disabled=is_busy,
            ):
                st.session_state.theme_mode = "light" if is_dark else "dark"
                st.rerun()
        with clear_col:
            if st.button(
                "🗑️",
                key="nav_clear_btn",
                help="清空当前对话并重置 Token 统计",
                disabled=is_busy or not st.session_state.messages,
            ):
                clear_conversation()
                st.rerun()


def render_sidebar() -> None:
    """渲染侧边栏控制台：上下文轮数、System Prompt、Token 统计、导出、清空与退出。"""
    is_busy = st.session_state.is_generating
    active_model = st.session_state.selected_model

    with st.sidebar:
        st.markdown(
            "<div class='nav-brand' style='margin-bottom:6px;'>"
            "<span class='starburst-icon'></span>"
            "<span class='nav-title' style='font-size:1.05rem;'>对话控制台</span>"
            "</div>",
            unsafe_allow_html=True,
        )
        st.caption(f"当前模型：`{active_model}`")

        st.divider()

        st.slider(
            "上下文携带轮数",
            min_value=MIN_CONTEXT_TURNS,
            max_value=MAX_CONTEXT_TURNS,
            step=1,
            key="context_turns",
            disabled=is_busy,
            help="页面始终保留全部历史记录，但每次请求仅发送最近 N 轮对话，用于有效控制 Token 成本。",
        )

        st.selectbox(
            "System Prompt 预设",
            options=list(SYSTEM_PRESETS.keys()),
            key="system_preset",
            on_change=on_preset_change,
            disabled=is_busy,
        )
        st.text_area(
            "System Prompt 内容",
            key="system_prompt",
            height=110,
            on_change=on_system_prompt_edit,
            disabled=is_busy,
            placeholder="可选：设定模型角色、语气或输出规范（下一轮立即生效）...",
            help="不会写入历史消息，每次请求动态拼接到消息头部，修改后下一轮立即生效。",
        )

        st.divider()

        st.markdown("#### 📊 Token 消耗统计")
        st.caption("上一轮消耗")
        last_col1, last_col2 = st.columns(2)
        last_col1.metric("输入", f"{st.session_state.last_prompt_tokens:,}")
        last_col2.metric("输出", f"{st.session_state.last_completion_tokens:,}")

        st.caption("本次会话累计")
        total_col1, total_col2 = st.columns(2)
        total_col1.metric("累计输入", f"{st.session_state.total_prompt_tokens:,}")
        total_col2.metric("累计输出", f"{st.session_state.total_completion_tokens:,}")

        st.divider()

        export_filename = f"gemini_chat_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        markdown_content = export_chat_to_markdown(
            messages=st.session_state.messages,
            model_name=active_model,
            system_prompt=st.session_state.system_prompt,
        )
        st.download_button(
            label="📥 导出对话 (.md)",
            data=markdown_content.encode("utf-8"),
            file_name=export_filename,
            mime="text/markdown",
            use_container_width=True,
            disabled=is_busy or not st.session_state.messages,
        )

        if st.button(
            "🗑️ 清空当前对话",
            key="sidebar_clear_btn",
            use_container_width=True,
            disabled=is_busy or not st.session_state.messages,
        ):
            clear_conversation()
            st.rerun()

        if st.button(
            "🚪 退出登录",
            key="sidebar_logout_btn",
            use_container_width=True,
            disabled=is_busy,
        ):
            st.session_state.authenticated = False
            st.session_state.is_generating = False
            st.session_state.pending_generation = False
            st.session_state.last_error = None
            st.rerun()


# ==============================================================================
# 欢迎态、历史对话渲染与流式输出
# ==============================================================================


def render_welcome_state() -> None:
    """无消息时展示居中欢迎语 + 4 张毛玻璃快捷提问卡片（点击直接发起对话）。"""
    active_model = html.escape(st.session_state.selected_model)
    st.markdown(
        f"""
        <div class="welcome-hero">
            <div class="welcome-badge">
                <span class="starburst-icon"></span>
            </div>
            <h1 class="welcome-title">你好，今天想探索什么？</h1>
            <p class="welcome-subtitle">
                由 <code>{active_model}</code> 驱动 · 支持文字多轮对话与低成本识图分析
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
                        st.caption("（已上传图片）")
        else:
            is_last_assistant = idx == total - 1
            model_label = html.escape(msg.get("model") or st.session_state.selected_model)
            reply_text = msg.get("content", "")
            copy_b64 = base64.b64encode(reply_text.encode("utf-8")).decode("ascii")

            with st.container(key=f"assistant_msg_{idx}"):
                st.markdown(
                    f"<div class='ai-header'>"
                    f"<span class='starburst-icon'></span>"
                    f"<span class='ai-header-label'>{model_label}</span>"
                    f"</div>",
                    unsafe_allow_html=True,
                )
                if msg.get("reasoning"):
                    with st.expander("思考过程", expanded=False):
                        st.markdown(msg["reasoning"])

                st.markdown(reply_text)

                # 悬停平滑显示的「复制」「重新生成」操作栏
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
                                help="移除当前回复并基于上一条提问重新生成（包含图片时会一并重传）",
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

    # 若上一轮因异常中断未生成助手回复，提供一键重试按钮
    if (
        not is_busy
        and messages[-1]["role"] == "user"
        and not st.session_state.pending_generation
    ):
        if st.button(
            "↻ 重试生成",
            key="retry_btn",
            disabled=is_busy,
            help="基于上一条未成功获得回复的提问重新发起请求",
        ):
            if not st.session_state.is_generating and st.session_state.messages:
                st.session_state.last_error = None
                st.session_state.is_generating = True
                st.session_state.pending_generation = True
                st.rerun()


def stream_assistant_response(config: dict[str, Any]) -> None:
    """
    执行流式对话生成：
    - 仅在成功获得有效正文时才将助手消息写入对话历史
    - 异常或中断时绝不写入残缺内容，避免污染后续上下文
    - finally 中强制释放生成锁，防止界面永久卡死
    """
    error_message: str | None = None
    active_model = st.session_state.selected_model

    with st.container(key="assistant_msg_streaming"):
        st.markdown(
            f"<div class='ai-header'>"
            f"<span class='starburst-icon'></span>"
            f"<span class='ai-header-label'>{html.escape(active_model)}</span>"
            f"</div>",
            unsafe_allow_html=True,
        )
        loading_placeholder = st.empty()
        loading_placeholder.markdown(
            "<div class='thinking-pulse'>✦ 正在思考中...</div>",
            unsafe_allow_html=True,
        )
        reasoning_container = st.empty()
        content_placeholder = st.empty()

        reasoning_parts: list[str] = []
        content_parts: list[str] = []
        reasoning_placeholder: Any = None
        first_content_received = False
        usage_info: Any = None

        try:
            client = get_openai_client(config["api_key"], config["base_url"])
            api_messages = build_api_messages(
                history=st.session_state.messages,
                context_turns=st.session_state.context_turns,
                system_prompt=st.session_state.system_prompt,
            )

            request_kwargs: dict[str, Any] = {
                "model": active_model,
                "messages": api_messages,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            if config["reasoning_effort"] is not None:
                request_kwargs["reasoning_effort"] = config["reasoning_effort"]

            stream = client.chat.completions.create(**request_kwargs)

            for chunk in stream:
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    usage_info = chunk_usage

                choices = getattr(chunk, "choices", None)
                if not choices:
                    continue

                delta = getattr(choices[0], "delta", None)
                if delta is None:
                    continue

                reasoning_piece = getattr(delta, "reasoning_content", None)
                if reasoning_piece:
                    reasoning_parts.append(reasoning_piece)
                    if reasoning_placeholder is None:
                        with reasoning_container.expander("思考过程", expanded=False):
                            reasoning_placeholder = st.empty()
                    reasoning_placeholder.markdown("".join(reasoning_parts))

                content_piece = getattr(delta, "content", None)
                if content_piece:
                    if not first_content_received:
                        first_content_received = True
                        loading_placeholder.empty()
                    content_parts.append(content_piece)
                    content_placeholder.markdown("".join(content_parts) + "▌")

            loading_placeholder.empty()
            full_reply = "".join(content_parts)
            full_reasoning = "".join(reasoning_parts).strip()

            if not full_reply.strip():
                error_message = "⚠️ 模型未返回有效正文，可能触发了内容安全策略或连接提前中断，请尝试调整表述后重试。"
            else:
                content_placeholder.markdown(full_reply)

                if usage_info is not None:
                    prompt_tokens = int(getattr(usage_info, "prompt_tokens", 0) or 0)
                    completion_tokens = int(
                        getattr(usage_info, "completion_tokens", 0) or 0
                    )
                    st.session_state.last_prompt_tokens = prompt_tokens
                    st.session_state.last_completion_tokens = completion_tokens
                    st.session_state.total_prompt_tokens += prompt_tokens
                    st.session_state.total_completion_tokens += completion_tokens

                st.session_state.messages.append(
                    {
                        "role": "assistant",
                        "content": full_reply,
                        "reasoning": full_reasoning or None,
                        "model": active_model,
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
    """渲染底部悬浮圆角胶囊输入框（支持附带图片与输入上限校验）。"""
    prompt = st.chat_input(
        placeholder=f"向星芒 AI 提问，或点击左侧回形针附带图片（最多 {MAX_INPUT_CHARS:,} 字）...",
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
            f"单次输入长度不能超过 {MAX_INPUT_CHARS:,} 个字符（当前 {len(user_text):,} 字符），请精简后再发送。"
        )
        return

    image_b64: str | None = None
    if uploaded_files:
        try:
            image_b64 = process_uploaded_image(uploaded_files[0])
        except (UnidentifiedImageError, OSError, ValueError):
            st.error("图片解析失败，请确认上传的是有效的 PNG / JPG / WebP 图片文件。")
            return

    submit_user_message(user_text, image_b64)


# ==============================================================================
# 主入口
# ==============================================================================


def main() -> None:
    st.set_page_config(
        page_title="星芒 AI · Gemini 4 Hydrogen",
        page_icon="✦",
        layout="wide",
        initial_sidebar_state="collapsed",
    )

    config = load_config()
    init_session_state(config["model_name"])
    inject_glass_theme_css(st.session_state.theme_mode)

    # 1. 启动环境变量 / Secrets 兜底检查
    ensure_env_configured(config)

    # 2. 登录门禁（未登录时彻底阻断侧边栏、导航栏与聊天主界面）
    ensure_authenticated(config["access_password"])

    # 3. 侧边栏与 56px 顶部固定毛玻璃导航栏
    render_sidebar()
    render_top_navbar(config)

    # 4. 768px 居中主对话舞台
    with st.container(key="chat_stage"):
        render_chat_history()

        if st.session_state.last_error:
            st.error(st.session_state.last_error)

        if st.session_state.pending_generation:
            stream_assistant_response(config)

    # 5. 底部悬浮圆角胶囊输入框 + 客户端交互增强（代码栏、复制按钮、回到底部）
    handle_chat_input()
    inject_ui_enhancer(is_streaming=st.session_state.pending_generation)


if __name__ == "__main__":
    main()
