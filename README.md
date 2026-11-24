---
title: Gemini 4 Hydrogen AI Chat
emoji: 🤖
colorFrom: blue
colorTo: indigo
sdk: streamlit
sdk_version: 1.43.0
app_file: app.py
pinned: false
---

# Gemini 4 Hydrogen 小圈子 AI 助手

基于 **Streamlit** 与 **Google Gemini API（OpenAI 兼容模式）** 构建的轻量级多模态 AI 聊天机器人，默认接入 **`gemini-4-hydrogen`** 模型，专为 **10 人以内内部小圈子**设计，在严格控制 API 成本的前提下提供流畅的对话体验。

---

## 核心特性与成本控制

- **安全访问门禁**：零硬编码密钥；启动时强制校验环境变量，支持 `hmac.compare_digest` 常量时间密码比对与错误延迟防爆破，未登录时彻底阻断侧边栏与聊天界面渲染。
- **展示完整、发送截断**：页面完整保留所有历史消息，但每次 API 请求仅发送最近 $N$ 轮上下文（侧边栏可调 `2–12` 轮，默认 `6` 轮）。
- **低成本多模态识图**：自动校正手机照片 EXIF 方向、透明通道白底合成 RGB、长边等比缩放至 `1024px` 以内并转 JPEG（质量 80）；历史图片留在界面供回顾，但仅在当前提问轮次发送给模型，后续纯文字追问不重复消耗图片 Token。
- **输入 / 输出与思考深度兜底**：单次输入上限 `12,000` 字符、单次输出上限 `4,096` tokens、默认 `reasoning_effort="low"`、客户端显式配置 `timeout=60.0` 与 `max_retries=1`。
- **完整交互体验**：流式输出（首字前加载提示、思考过程折叠展示）、实时 Token 消耗统计（上一轮 / 本次会话累计）、System Prompt 预设与热切换、重新生成（支持重传图片）与防连点保护、一键导出 Markdown、异常不污染历史记录。

---

## 第一步：获取 Google AI Studio API Key

1. 访问 [Google AI Studio](https://aistudio.google.com/) 并使用 Google 账号登录。
2. 在左侧导航栏或顶部菜单点击 **Get API key**（获取 API 密钥）。
3. 点击 **Create API key**（创建 API 密钥），选择或新建一个 Google Cloud 项目，生成以 `AIza...` 开头的密钥。
4. 复制并妥善保存该密钥（**切勿提交到公开仓库或分享给他人**）。
5. 建议在 Google AI Studio / Google Cloud Console 中为该 Key 绑定预算告警（Budget Alert），进一步管控月度费用。

---

## 第二步：部署到 Streamlit Community Cloud（推荐 · 免费）

1. 将本项目的 `app.py`、`requirements.txt`、`README.md` 推送到 GitHub 仓库（公开或私有仓库均可）。
2. 访问 [Streamlit Community Cloud](https://share.streamlit.io/) 并使用 GitHub 账号登录。
3. 点击 **Create app** → **Deploy a public app from GitHub**（或选择已有仓库）：
   - **Repository**：选择你的 GitHub 仓库
   - **Branch**：`main`
   - **Main file path**：`app.py`
4. 点击 **Advanced settings...**，在 **Secrets** 文本框中按 TOML 格式填写必填密钥（也可部署后再进入 **Settings → Secrets** 修改）：

```toml
GEMINI_API_KEY = "你的_Google_AI_Studio_API_Key"
ACCESS_PASSWORD = "你的强访问密码"

# 以下为可选项（不填则使用默认值）
# MODEL_NAME = "gemini-4-hydrogen"
# BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
# REASONING_EFFORT = "low"
```

5. 点击 **Save** → **Deploy!**，等待依赖安装完成后即可通过生成的 `.streamlit.app` 链接访问。

---

## 备选部署：Hugging Face Spaces（需 PRO 订阅 / Docker）

### 1. 创建 Streamlit Space

1. 登录 [Hugging Face](https://huggingface.co/)，点击右上角头像 → **New Space**。
2. 填写 **Space name**（例如 `my-gemini-chat`）。
3. **Select the Space SDK** 选择 **Streamlit**。
4. **Visibility（可见性）** 建议优先选择 **Private**（如希望圈内成员免登 Hugging Face 直接访问，也可设为 **Public**，通过本应用的 `ACCESS_PASSWORD` 门禁保护）。
5. 硬件选择免费的 **CPU basic** 即可流畅运行，点击 **Create Space**。

### 2. 上传项目文件

将本项目的以下 3 个文件推送（或通过网页 **Files → Add file** 上传）到 Space 仓库根目录：

- `app.py`
- `requirements.txt`
- `README.md`（保留顶部 `--- ... ---` YAML 配置块，已指定 `sdk: streamlit`、`sdk_version: 1.43.0` 与 `app_file: app.py`）

### 3. 在 `Settings -> Secrets` 中配置环境变量（必填）

1. 打开你的 Space 页面，点击顶部导航栏的 **Settings**。
2. 向下滚动至 **Variables and secrets** 区域，点击 **New secret** 依次添加以下两个必填项：

| Secret 名称 | 必填 | 说明 |
| :--- | :---: | :--- |
| `GEMINI_API_KEY` | 是 | 第一步从 Google AI Studio 获取的 API Key |
| `ACCESS_PASSWORD` | 是 | 供小圈子内部成员登录使用的强密码（建议 12 位以上字母+数字组合） |

3. （可选）如需自定义模型、端点或思考深度，可在 **Variables** 或 **Secrets** 中配置以下可选项：

| 变量名称 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `MODEL_NAME` | `gemini-4-hydrogen` | 目标模型名称 |
| `BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai/` | OpenAI 兼容端点地址 |
| `REASONING_EFFORT` | `low` | 思考深度（如 `low` / `medium` / `high`）；**不要设为 `none`**；若显式设为空字符串，则请求时不传该字段（便于切换不支持此参数的模型） |

4. 保存 Secrets 后，Space 会自动重启并构建；待状态变为 **Running** 后，即可在 **App** 标签页输入 `ACCESS_PASSWORD` 登录使用。

---

## 本地运行指南（可选）

确保本地已安装 **Python 3.10+**，在项目根目录执行：

```bash
pip install -r requirements.txt
```

### Linux / macOS

```bash
export GEMINI_API_KEY="你的_Google_AI_Studio_API_Key"
export ACCESS_PASSWORD="你的访问密码"
streamlit run app.py
```

### Windows (PowerShell)

```powershell
$env:GEMINI_API_KEY="你的_Google_AI_Studio_API_Key"
$env:ACCESS_PASSWORD="你的访问密码"
streamlit run app.py
```

---

## 注意事项

- Streamlit 刷新页面或 Hugging Face 免费 Space 休眠会重置内存中的会话历史；重要对话请随时点击侧边栏 **导出对话 (.md)** 保存到本地。
- 如成员变动，只需在 Space 的 `Settings → Variables and secrets` 修改 `ACCESS_PASSWORD` 即可即时失效旧密码。
