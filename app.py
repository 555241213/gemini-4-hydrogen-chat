"""
Gemini 4 Hydrogen 小圈子轻量级 AI 对话应用（Streamlit + OpenAI 兼容端点）

设计目标：
- 面向 10 人以内内部小圈子，严格通过环境变量与访问密码进行鉴权隔离。
- 严格控制 API 成本：滑动窗口截断上下文、单轮传图压缩、输入/输出长度上限、默认 low 思考深度。
- 生产可用：流式输出边界保护、思考过程折叠展示、防连点状态锁、异常不污染历史、适配 Hugging Face Spaces。
"""

from __future__ import annotations

import base64
from datetime import datetime
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

# ==============================================================================
# 全局常量配置
# ==============================================================================

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_MODEL_NAME = "gemini-4-hydrogen"
DEFAULT_REASONING_EFFORT = "low"

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
        # 本地未配置 .streamlit/secrets.toml 时静默忽略
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


def init_session_state() -> None:
    """初始化会话级状态变量。"""
    defaults: dict[str, Any] = {
        "authenticated": False,
        "messages": [],  # 元素结构见下方注释
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
        st.title("⚙️ 服务尚未完成初始化配置")
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
    """登录门禁：未通过验证时仅渲染居中登录表单并彻底阻断主界面与侧边栏。"""
    if st.session_state.get("authenticated", False):
        return

    st.markdown("<div style='height: 10vh;'></div>", unsafe_allow_html=True)
    _, center_col, _ = st.columns([1, 1.4, 1])

    with center_col:
        st.markdown("### 🔐 内部 AI 助手登录")
        st.caption("本应用仅限小圈子内部成员使用，请输入访问密码继续。")

        with st.form("login_form", clear_on_submit=False):
            password_input = st.text_input(
                "访问密码",
                type="password",
                placeholder="请输入访问密码",
                autocomplete="current-password",
            )
            submitted = st.form_submit_button(
                "进入对话",
                use_container_width=True,
                type="primary",
            )

        if submitted:
            # 使用 UTF-8 字节进行常量时间比对，既防时序攻击又兼容非 ASCII 字符密码
            is_valid = hmac.compare_digest(
                password_input.encode("utf-8"),
                access_password.encode("utf-8"),
            )
            if is_valid:
                st.session_state.authenticated = True
                st.session_state.last_error = None
                st.rerun()
            else:
                # 基础防暴力尝试延迟
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

        # thumbnail 会保持宽高比，且仅当超过上限时才缩小
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

    # 截取最近 N 轮（每轮最多 2 条消息），并剔除窗口开头可能出现的孤立 assistant 消息
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
            # 历史轮次不携带图片 Base64；若该轮仅上传了图片，保留简短文本占位以维持语义连贯
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


# ==============================================================================
# 侧边栏渲染与回调
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


def render_sidebar(config: dict[str, Any]) -> None:
    """渲染侧边栏：上下文窗口、System Prompt、Token 统计、导出、清空与退出。"""
    is_busy = st.session_state.is_generating

    with st.sidebar:
        st.markdown("## 🤖 对话控制台")
        st.caption(f"当前模型：`{config['model_name']}`")

        st.divider()

        # 1. 上下文携带轮数滑块（展示完整、发送截断）
        st.slider(
            "上下文携带轮数",
            min_value=MIN_CONTEXT_TURNS,
            max_value=MAX_CONTEXT_TURNS,
            step=1,
            key="context_turns",
            disabled=is_busy,
            help="页面始终保留全部历史记录，但每次请求仅发送最近 N 轮对话，用于有效控制 Token 成本。",
        )

        # 2. System Prompt 快捷预设与自定义
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

        # 3. Token 消耗统计
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

        # 4. 一键导出对话（Markdown）
        export_filename = f"gemini_chat_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        markdown_content = export_chat_to_markdown(
            messages=st.session_state.messages,
            model_name=config["model_name"],
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

        # 5. 清空当前对话
        if st.button(
            "🗑️ 清空当前对话",
            use_container_width=True,
            disabled=is_busy or not st.session_state.messages,
        ):
            st.session_state.messages = []
            st.session_state.last_prompt_tokens = 0
            st.session_state.last_completion_tokens = 0
            st.session_state.total_prompt_tokens = 0
            st.session_state.total_completion_tokens = 0
            st.session_state.last_error = None
            st.rerun()

        # 6. 退出登录
        if st.button(
            "🚪 退出登录",
            use_container_width=True,
            disabled=is_busy,
        ):
            st.session_state.authenticated = False
            st.session_state.is_generating = False
            st.session_state.pending_generation = False
            st.session_state.last_error = None
            st.rerun()


# ==============================================================================
# 流式回复执行与主对话界面
# ==============================================================================


def stream_assistant_response(config: dict[str, Any]) -> None:
    """
    执行流式对话生成：
    - 仅在成功获得有效正文时才将助手消息写入对话历史
    - 异常或中断时绝不写入残缺内容，避免污染后续上下文
    - finally 中强制释放生成锁，防止界面永久卡死
    """
    error_message: str | None = None

    with st.chat_message("assistant"):
        loading_placeholder = st.empty()
        loading_placeholder.markdown("⏳ 正在思考中...")
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
                "model": config["model_name"],
                "messages": api_messages,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            if config["reasoning_effort"] is not None:
                request_kwargs["reasoning_effort"] = config["reasoning_effort"]

            stream = client.chat.completions.create(**request_kwargs)

            for chunk in stream:
                # 流式最后一个分片通常包含 usage 且 choices 可能为空列表，需先独立读取
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    usage_info = chunk_usage

                choices = getattr(chunk, "choices", None)
                if not choices:
                    continue

                delta = getattr(choices[0], "delta", None)
                if delta is None:
                    continue

                # 安全提取思考过程并折叠展示，不混入正文
                reasoning_piece = getattr(delta, "reasoning_content", None)
                if reasoning_piece:
                    reasoning_parts.append(reasoning_piece)
                    if reasoning_placeholder is None:
                        with reasoning_container.expander("思考过程", expanded=False):
                            reasoning_placeholder = st.empty()
                    reasoning_placeholder.markdown("".join(reasoning_parts))

                # 安全提取正文内容；收到首个正文分片后清除加载提示
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

                # 更新 Token 统计
                if usage_info is not None:
                    prompt_tokens = int(getattr(usage_info, "prompt_tokens", 0) or 0)
                    completion_tokens = int(
                        getattr(usage_info, "completion_tokens", 0) or 0
                    )
                    st.session_state.last_prompt_tokens = prompt_tokens
                    st.session_state.last_completion_tokens = completion_tokens
                    st.session_state.total_prompt_tokens += prompt_tokens
                    st.session_state.total_completion_tokens += completion_tokens

                # 仅在完整成功后写入历史记录
                st.session_state.messages.append(
                    {
                        "role": "assistant",
                        "content": full_reply,
                        "reasoning": full_reasoning or None,
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


def render_chat_history() -> None:
    """渲染全部历史对话消息，并在最新一条助手回复下方提供“重新生成”按钮。"""
    messages = st.session_state.messages
    if not messages:
        st.info(
            "👋 欢迎使用！你可以直接输入问题，或点击输入框左侧回形针附带图片进行提问。"
            "（单次图片仅在当前提问轮次发送给模型，后续追问不重复消耗图片 Token）"
        )
        return

    for msg in messages:
        role = msg["role"]
        with st.chat_message(role):
            if role == "user":
                image_b64 = msg.get("image_b64")
                if image_b64:
                    st.image(base64.b64decode(image_b64), width=360)
                if msg.get("content"):
                    st.markdown(msg["content"])
                elif image_b64:
                    st.caption("（已上传图片）")
            else:
                if msg.get("reasoning"):
                    with st.expander("思考过程", expanded=False):
                        st.markdown(msg["reasoning"])
                st.markdown(msg.get("content", ""))

    # 操作区：最新一条为助手回复时提供“重新生成”；若上一轮因异常未生成回复，则提供“重试生成”
    if not st.session_state.is_generating:
        last_role = messages[-1]["role"]
        if last_role == "assistant":
            if st.button(
                "🔄 重新生成",
                key="regenerate_btn",
                disabled=st.session_state.is_generating,
                help="移除当前最新回复并基于上一条提问重新生成（若上一条包含图片会一并重传）",
            ):
                # 二次保护：确认未处于生成状态且最后一条确为助手消息
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
        elif last_role == "user" and not st.session_state.pending_generation:
            if st.button(
                "🔄 重试生成",
                key="retry_btn",
                disabled=st.session_state.is_generating,
                help="基于上一条未成功获得回复的提问重新发起请求",
            ):
                if not st.session_state.is_generating and st.session_state.messages:
                    st.session_state.last_error = None
                    st.session_state.is_generating = True
                    st.session_state.pending_generation = True
                    st.rerun()


def handle_chat_input() -> None:
    """渲染原生带图聊天输入框并处理用户输入校验与图片压缩。"""
    prompt = st.chat_input(
        placeholder=f"输入消息，可附带图片（最多 {MAX_INPUT_CHARS:,} 字）...",
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

    # 服务端再次校验字符上限，防止绕过前端限制导致 Input Token 暴涨
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

    # 写入用户消息并置位生成锁，rerun 后先禁用交互控件再开始流式输出
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
# 主入口
# ==============================================================================


def main() -> None:
    st.set_page_config(
        page_title="Gemini 4 Hydrogen AI 助手",
        page_icon="🤖",
        layout="centered",
        initial_sidebar_state="expanded",
    )

    init_session_state()
    config = load_config()

    # 1. 启动环境变量兜底检查
    ensure_env_configured(config)

    # 2. 登录门禁（未登录时阻断侧边栏与聊天主界面）
    ensure_authenticated(config["access_password"])

    # 3. 侧边栏与主聊天界面
    render_sidebar(config)

    st.title("💬 Gemini 4 Hydrogen AI 助手")
    render_chat_history()

    if st.session_state.last_error:
        st.error(st.session_state.last_error)

    # 若存在待生成请求，在助手气泡中执行流式输出
    if st.session_state.pending_generation:
        stream_assistant_response(config)

    # 原生带图聊天输入框（发送后自动清空文本与附件）
    handle_chat_input()


if __name__ == "__main__":
    main()
