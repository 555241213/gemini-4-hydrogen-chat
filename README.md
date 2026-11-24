# 星芒 AI · 小圈子云端日常聊天网站（Cloudflare Pages + D1 免费版）

面向 **10 人以内内部小圈子** 的轻量日常多模态 AI 聊天网站，采用 **Cloudflare Pages + Pages Functions + Cloudflare D1 云数据库 + 原生「深邃毛玻璃风」前端**，零服务器月费，并支持绑定自定义域名（如 `hanxu555.dpdns.org`）改善国内免代理访问体验。

---

## 核心特性

- **一人一密 + 云端独立存储**：后台在 `USER_PASSWORDS` 中为最多 10 位成员每人配置一个专属密码；每位成员输入自己的密码登录后，聊天记录与压缩图片自动保存在 Cloudflare **D1** 云数据库中，按账号严格隔离，换设备或刷新后无缝续聊。
- **纯净日常体验（「深邃毛玻璃风」）**：去掉侧边栏、Token 面板、System Prompt 编辑器、模型切换、思考过程折叠与欢迎快捷卡片，默认深色模式并支持顶部一键切换浅色/深色。
- **零外部 CDN 依赖**：Markdown 渲染与代码卡片复制全部内置，所有静态资源仅从你自己的域名加载。
- **成本与稳定性防线**：
  - 默认模型 `gemini-4-hydrogen`（通过 Google Gemini OpenAI 兼容端点调用），API Key 仅保存在服务端，绝不暴露到前端。
  - 单次输入上限 `12,000` 字符、单次输出上限 `4,096` tokens、默认 `reasoning_effort="low"`、`timeout=60s`。
  - 浏览器端自动将图片白底合成、长边缩放至 `<=1024px` 并压缩为 JPEG（质量 80）；请求模型时仅截取最近 `6` 轮上下文，且**仅当前提问轮次发送图片**。

---

## 快速部署指南（Cloudflare Pages + D1）

### 第一步：将 `hanxu555.dpdns.org` 接入 Cloudflare DNS
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，点击 **Add a domain**，输入 `hanxu555.dpdns.org`，选择 **Free** 免费计划。
2. 复制 Cloudflare 分配给你的两组 **Nameservers（NS 记录）**。
3. 前往 DigitalPlat FreeDomain 控制台修改 `hanxu555.dpdns.org` 的 NS 记录为这两组 Cloudflare NS 地址，等待几分钟生效。

### 第二步：创建免费的 Cloudflare D1 云数据库
1. 在 Cloudflare 控制台左侧进入 **Storage & Databases → D1 SQL Database** → 点击 **Create**。
2. 数据库名称填 `xingmang-chat-db`（位置选默认即可），点击 **Create**。
   > 应用首次运行会自动建表，无需手动执行 SQL；如需手动建表也可在 Console 中粘贴 [schema.sql](schema.sql)。

### 第三步：连接 GitHub 仓库部署 Pages
1. 在 Cloudflare 控制台进入 **Workers & Pages → Create → Pages → Connect to Git**。
2. 选择仓库 `555241213/gemini-4-hydrogen-chat`（分支 `main`）：
   - **Framework preset**：`None`
   - **Build command**：留空
   - **Build output directory**：`public`
3. 点击 **Save and Deploy** 完成首次构建。

### 第四步：绑定 D1 数据库与配置环境变量
1. 进入刚刚部署的 Pages 项目 → **Settings → Bindings**（或 **Functions → D1 database bindings**）：
   - 点击 **Add** → 选择 **D1 database**
   - **Variable name**：严格填写 `DB`
   - **D1 database**：选择 `xingmang-chat-db`
2. 进入 **Settings → Variables and Secrets**，添加以下必填项（建议选择 **Encrypt** 加密保存）：

| 变量名 | 必填 | 示例 / 说明 |
| :--- | :---: | :--- |
| `GEMINI_API_KEY` | 是 | Google AI Studio 获取的 API Key |
| `USER_PASSWORDS` | 是 | 一人一密配置（上限 10 人），支持 `小明:pass123,小红:pass456` 或 JSON `{"小明":"pass123","小红":"pass456"}` |
| `MODEL_NAME` | 否 | 默认 `gemini-4-hydrogen` |
| `BASE_URL` | 否 | 默认 `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `REASONING_EFFORT` | 否 | 默认 `low`（不要设为 `none`，留空则不传该字段） |
| `SESSION_SECRET` | 否 | 可选；不填时系统会基于服务端密钥自动派生 |

3. 进入 **Deployments** 对最新一次部署点击 **Retry deployment**，使绑定和环境变量生效。

### 第五步：绑定自定义域名 `hanxu555.dpdns.org`
1. 进入该 Pages 项目的 **Custom domains → Set up a custom domain**。
2. 输入 `hanxu555.dpdns.org` 并确认，Cloudflare 会自动添加 DNS 记录与 HTTPS 证书。
3. 证书签发完成后，将 `https://hanxu555.dpdns.org` 和各自的专属密码分别发给圈内成员即可。

---

## 本地单元测试

项目已包含基于 Node.js 内置测试运行器的单元测试（需 Node.js 20+）：

```bash
node --test tests/unit.mjs
```
