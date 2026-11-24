# 星芒 AI · 小圈子云端日常聊天网站（Cloudflare Pages + D1）

面向 **10 人以内内部小圈子** 的轻量日常多模态 AI 聊天网站，采用 **Cloudflare Pages + Pages Functions + Cloudflare D1 云数据库 + 原生「深邃毛玻璃风」前端**，零服务器月费，支持绑定自定义域名，并提供管理员后台实时切换 **DeepSeek V4.1 Flash** 与 **Gemini 4** 系列模型。

---

## 核心特性

- **管理员后台（实时切换模型与成员管理）**：
  - 使用管理员密码登录后，顶部导航栏出现 **⚙️ 管理后台** 按钮（普通成员不可见且后端严格鉴权 `403`）。
  - 支持在 **DeepSeek V4.1 Flash（`deepseek-flash`）**、**Gemini 4 Hydrogen / Argon / Neon**、**Gemini 3.8 Flash** 以及自定义 OpenAI 兼容端点之间一键切换，无需重启或重部署。
  - 支持在后台填写/更新 `DeepSeek API Key` 与 `Gemini API Key`（脱敏回显，不暴露明文）、测试连通性，以及在线增删/修改圈子成员密码。
- **用户端「新建对话」与云端多对话管理**：
  - 点击顶部 **`＋`** 一键开启新对话；点击左上角 **`☰`** 滑出毛玻璃对话列表抽屉，随时切换、续聊或单独删除某条历史对话。
  - 每位成员拥有独立的 D1 云端会话与图片存储，刷新或换设备无缝续聊，彼此严格隔离。
- **成本与稳定性防线**：
  - API Key 仅保存在服务端与 D1，绝不暴露到前端；单次输入上限 `12,000` 字符、单次输出上限 `4,096` tokens、默认 `reasoning_effort="low"`、`timeout=60s`。
  - 浏览器端自动将图片白底合成、长边缩放至 `<=1024px` 并压缩为 JPEG（质量 80）；每次请求仅截取当前对话最近 `6` 轮上下文，且**仅当前提问轮次传图**。
  - Gemini 4 主模型遇到高峰 `HTTP 503` 时自动短等重试并回退到 `gemini-3.8-flash`。

---

## 环境变量与管理员配置（Cloudflare Pages → Variables and Secrets）

| 变量名 | 必填 | 说明 |
| :--- | :---: | :--- |
| `ADMIN_PASSWORD` | 推荐 | 管理员专属登录密码（或把 `USER_PASSWORDS` 中自己昵称设为 `admin` / `管理员`） |
| `USER_PASSWORDS` | 是 | 成员密码列表，如 `小红:pass123,小明:pass456`（也可在管理员后台在线增删） |
| `GEMINI_API_KEY` | 二选一 | Google AI Studio API Key（也可在管理员后台界面填写） |
| `DEEPSEEK_API_KEY` | 二选一 | DeepSeek 官方 API Key（也可在管理员后台界面填写） |
| `MODEL_NAME` | 否 | 初始默认模型，默认 `gemini-4-hydrogen` |
| `REASONING_EFFORT` | 否 | 默认 `low`（Gemini 4 不支持设为 `none`） |

---

## 本地单元测试

```bash
node --test tests/unit.mjs
```
