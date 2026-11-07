# GitHub Knowledge Hub

[![CI](https://github.com/zhongli369/github-knowledge-hub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zhongli369/github-knowledge-hub/actions/workflows/ci.yml?query=branch%3Amain)

**把 GitHub 仓库和 Stars 从“链接收藏夹”，变成可理解、可检索、可整理的个人知识库。**

同步自己的仓库与星标仓库，生成 AI 摘要，提取可复用代码资产，再通过全文 / 语义 / 混合搜索、功能分类和收藏集重新找到它们。

> **项目状态：阶段性封板，进入维护。** 当前主要面向 Windows 上的个人本地使用，不是托管 SaaS，也不是开箱即用的生产部署方案。AI 与语义搜索能力取决于你配置的外部服务。

## 界面预览

以下截图来自本地真实实例；仓库数据由 GitHub 同步而来，新安装不会自带这些数据。账户信息已从截图中隐藏。

| Dashboard 总览 | Library 知识库 |
|---|---|
| ![Dashboard：仓库、分析和收藏集统计](docs/screenshots/01-dashboard.png) | ![Library：仓库搜索、筛选和状态管理](docs/screenshots/02-library.png) |

| AI 仓库摘要 | 功能分类与收藏 |
|---|---|
| ![仓库详情：AI 摘要、技术栈、使用场景和学习价值](docs/screenshots/03-repository-summary.png) | ![功能分类：按用途整理仓库](docs/screenshots/04-collections.png) |

## 核心功能

- **仓库同步**：同步“我的仓库”和 Starred 仓库，支持增量去重；取消 Star 不会删除已有知识资产。
- **AI 仓库摘要**：生成一句话介绍、解决的问题、技术栈、使用场景、亮点、学习价值和通俗解释；支持缓存与重试。
- **知识资产提取**：由独立 Worker 从 README、文件树和源码中提取设计模式、算法与代码片段。
- **三种搜索方式**：keyword、semantic、hybrid，支持筛选、分页和相似仓库推荐。
- **分类与收藏**：按 AI / Agent、前端、后端、DevOps、安全等用途分类，也支持自定义收藏集。
- **个人知识管理**：仓库笔记、状态跟踪、Topic 筛选、分析历史和可选的周期同步。
- **数据隔离与安全**：Repository、Analysis 等按用户隔离；新写入的 OAuth Token 使用 AES-256-GCM 加密。

## 技术栈与架构

Next.js 15 · React 19 · TypeScript · Auth.js v5 · Prisma 6 · PostgreSQL 17 + pgvector · Octokit · OpenAI-compatible API · Tailwind CSS 4 · Vitest

```text
Browser
   │
   ▼
Next.js Web ───────► GitHub API / LLM / Embedding Provider
   │
   ▼
PostgreSQL + pgvector ◄────── Analysis Worker / Automation Worker
```

- **Web**：页面、Auth.js、Server Actions、仓库同步、搜索和直接摘要。
- **Analysis Worker**：领取并执行知识资产提取及后台分析任务。
- **Automation Worker**：执行可选的周期同步调度，默认不启用自动任务。
- **Docker Compose**：只负责 PostgreSQL + pgvector；Web 和 Worker 运行在宿主机 Node.js 中。

更完整的实体关系与数据流见 [架构说明](docs/ARCHITECTURE.md)。

---

## 详细安装步骤（Windows 11 + Docker Desktop）

### 第 1 步：检查前置环境

准备以下软件：

| 软件 | 要求 | 用途 |
|---|---|---|
| Git | 当前稳定版 | 克隆仓库 |
| Node.js | **24，与 CI 一致** | 运行 Next.js、Worker 和 npm scripts |
| Docker Desktop | 包含 Docker Compose v2 | 运行 PostgreSQL 17 + pgvector |
| GitHub 账号 | 能创建 OAuth App | 登录和读取仓库 |
| OpenAI-compatible 服务 | 完整 AI 功能需要 | 摘要、分类、资产提取和 Embedding |

先打开 Docker Desktop，再在 PowerShell 中检查：

```powershell
git --version
node --version
npm --version
docker version
docker compose version
```

如果 `docker version` 只能看到 Client、看不到 Server，说明 Docker Engine 尚未就绪；先启动 Docker Desktop，不要直接执行数据库命令。

### 第 2 步：克隆仓库并安装依赖

```powershell
git clone https://github.com/zhongli369/github-knowledge-hub.git
cd github-knowledge-hub
npm ci
```

`npm ci` 按 `package-lock.json` 安装固定依赖。不要在安装阶段顺手升级 Next.js、React、Prisma 或其他依赖。

如果目标目录已经存在且有未提交修改，不要覆盖或清理它；先执行 `git status` 并确认如何处理。

### 第 3 步：创建本地 `.env`

PowerShell：

```powershell
Copy-Item .env.example .env
```

Git Bash：

```bash
cp .env.example .env
```

生成两个**不同**的随机密钥。以下命令运行两次，分别用于 `AUTH_SECRET` 和 `TOKEN_ENCRYPTION_KEY`：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

只把输出填写到本机 `.env`，不要提交、上传或粘贴到公开聊天中。

全新本地安装至少核对以下变量：

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/github_knowledge_hub?schema=public"

AUTH_SECRET="<第一个随机值>"
AUTH_GITHUB_ID="<GitHub OAuth App Client ID>"
AUTH_GITHUB_SECRET="<GitHub OAuth App Client Secret>"
TOKEN_ENCRYPTION_KEY="<第二个随机值>"

OPENAI_API_KEY="<你的 LLM API Key>"
OPENAI_BASE_URL="https://api.openai.com/v1"
OPENAI_MODEL="gpt-4o-mini"
```

注意事项：

- `TOKEN_ENCRYPTION_KEY` 必须是 base64 编码的 32-byte key，并且跨重启稳定保存。丢失后，已加密的历史 Token 将无法解密。
- 默认数据库密码仅适合本机开发；不要把这套配置直接暴露到公网。
- `GITHUB_TOKEN` 不是常规登录的必填项，业务代码通常使用当前用户的 OAuth Account Token。
- 真实 `.env` 已被 `.gitignore` 排除，不要绕过忽略规则强制提交。

### 第 4 步：创建并填写 GitHub OAuth App

打开 [GitHub Developer Settings → New OAuth App](https://github.com/settings/developers/new)，填写：

| 字段 | 本地开发值 |
|---|---|
| Application name | 任意可识别名称，例如 `GitHub Knowledge Hub Local` |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

创建后，把 **Client ID** 和新生成的 **Client Secret** 分别填入 `.env` 的 `AUTH_GITHUB_ID`、`AUTH_GITHUB_SECRET`。

当前登录会请求 `read:user user:email repo` scope。授权前请核对这些 GitHub 权限；回调地址必须与 OAuth App 中的配置完全一致。

> 如果使用其他端口或部署域名，需要同步修改 OAuth App、`AUTH_URL` 和回调地址。仅修改 Next.js 端口会导致 OAuth 回调不匹配。

### 第 5 步：按需配置 LLM 与 Embedding

**LLM 与 Embedding 是两项不同配置：会生成摘要，不代表已经具备语义搜索能力。**

- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`：用于仓库摘要、功能分类和知识资产分析。
- `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL`：用于向量生成；未填写时分别回退到 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。
- 当前代码固定使用 **`text-embedding-3-small`、1536 维向量**。`EMBEDDING_MODEL` 目前不会改变代码中的模型名。
- 如果 LLM 服务不提供兼容 Embedding，可以为 Embedding 单独配置另一家 OpenAI-compatible provider。

OpenAI 官方配置通常可以直接使用默认值。使用其他 LLM provider 时，将 `OPENAI_BASE_URL` 和 `OPENAI_MODEL` 改成该服务实际支持的值，不要照搬不存在的模型名。

暂不配置 AI 时仍可进行安装和数据库检查，但摘要、资产提取、语义 / 混合搜索等相关功能不能视为已验收。批量分析可能产生 API 费用，先用少量仓库测试。

### 第 6 步：初始化全新数据库

> 本步骤适用于**全新安装**。如果数据库由旧版 `db push` 创建、已有业务数据或已有 migration 历史，请先阅读[维护指南](docs/PROJECT_MAINTENANCE_GUIDE.md)，不要重复 baseline，更不要执行 reset。

启动 PostgreSQL：

```bash
docker compose up -d
docker exec github-knowledge-hub-db pg_isready -U postgres -d github_knowledge_hub
```

看到 `accepting connections` 后，应用版本化 migrations 并检查状态：

```bash
npm run db:deploy
npx prisma migrate status
```

预期结果为 migrations up to date。新环境不需要、也不应改用 `npm run db:push` 代替版本化 migration。

日常启动脚本不会自动执行 `db push`、`migrate deploy` 或创建扩展；schema 维护与日常启动保持分离。

### 第 7 步：启动 Web 与 Worker

**方式 A：Windows 桌面进程（推荐）**

```bash
npm run dev:desktop
```

启动器会检查 Docker、Prisma schema 和 migration 状态，然后启动 Web、Analysis Worker、Automation Worker，并在页面可访问后打开浏览器。重复启动会复用现有实例。

停止由启动器管理的进程：

```bash
npm run dev:desktop:stop
```

**方式 B：前台开发模式**

```bash
npm run dev:all
```

该命令运行 Web 和 Analysis Worker。需要周期自动同步时，再在另一个终端运行：

```bash
npm run worker:automation
```

也可以分别使用 `npm run dev`、`npm run worker` 和 `npm run worker:automation`。日志与 PID 的说明见[常用命令](#常用命令)。

### 第 8 步：完成首次登录与使用

1. 打开 [http://localhost:3000](http://localhost:3000)，点击 **Continue with GitHub** 完成 OAuth 授权。
2. 进入 **浏览仓库**，先点击 **同步星标仓库** 或 **同步我的仓库**。
3. 进入 **知识库**，使用关键词、语言、状态和 Topic 筛选仓库；可添加个人笔记和修改状态。
4. 打开一个仓库，点击 **生成摘要**。直接摘要由 Web 同步执行；生成后可展开查看缓存、模型和耗时信息。
5. 需要代码资产时点击提取入口，并确保 **Analysis Worker 正在运行**。只启动 Web 时，提取任务会保持 `pending`。
6. 在 **语义搜索** 中选择 keyword / semantic / hybrid。semantic 与 hybrid 需要已成功生成兼容的 Embedding。
7. 在 **收藏集** 中查看功能分类，或创建自己的收藏集。
8. 如需周期同步，到 **自动化** 中检查配置。周期调度和自动 AI 分析默认不启用，首次使用不必打开。

### 第 9 步：验证安装

基础静态与单元验证：

```bash
npx prisma validate
npm run typecheck
npm test
```

完整开发回归可再执行：

```bash
npm run lint
npm run test:integration
npm run build
```

`test:integration` 会从本地连接串派生独立的 `gkh_test_*` 数据库，只清理本次创建的测试库；不要用真实业务库手工模拟或替代这些测试。

安装验收应区分三件事：

- **安装完成**：依赖、migration、Web 与 Worker 启动成功。
- **基础可用**：能够打开页面并完成 GitHub OAuth 登录和仓库同步。
- **外部 AI 已验收**：真实执行过少量摘要 / Embedding 请求并核对结果。Mock 测试通过不等于外部服务已验收。

---

## 给 Agent 的安装提示词

下面这段可以直接复制给 Claude Code、Codex 或其他具备终端能力的编码 Agent。先填写目标目录；密钥由你在本机 `.env` 中填写，不要发进聊天。

```text
请在当前 Windows 11 + Docker Desktop 环境中安装并验收 GitHub Knowledge Hub。

仓库：https://github.com/zhongli369/github-knowledge-hub
目标目录：<填写一个明确的绝对路径；留空则先询问我>

请严格按以下步骤执行，并在每一步展示真实命令结果：
1. 阅读仓库 README.md、.env.example、docker-compose.yml 和项目 CLAUDE.md；以当前代码和文档为准，不凭记忆猜命令。
2. 检查 git、Node.js 24、npm、Docker Engine 和 Docker Compose v2。缺少前置条件时停止并告诉我如何安装，不擅自修改全局环境。
3. 如果目标目录不存在，克隆仓库；如果已存在，先执行 git status，保留所有未提交修改，不覆盖、不清理、不 reset。
4. 执行 npm ci，不顺手升级依赖。
5. 仅在 .env 不存在时从 .env.example 复制。不得覆盖已有 .env，不得打印、提交或上传其中的值。
6. 指导我在本机填写 AUTH_SECRET、TOKEN_ENCRYPTION_KEY、GitHub OAuth 和 LLM 配置。两个随机密钥必须不同，TOKEN_ENCRYPTION_KEY 必须是 base64 编码的 32-byte key。需要手工 OAuth 操作时暂停并等待我完成。
7. 执行 docker compose up -d，并用 pg_isready 检查 PostgreSQL。若端口被占用、已有同名容器或数据库非空，停止并报告；不要删除容器或 Volume。
8. 只有确认是全新数据库后才执行 npm run db:deploy，然后执行 npx prisma migrate status。既有 db push / 业务数据库先按维护指南检查，不执行 migrate reset、db push --force-reset 或 docker compose down -v。
9. 使用 npm run dev:desktop 启动 Web、Analysis Worker 和 Automation Worker；确认 http://localhost:3000 可访问。若启动失败，读取 logs/ 中对应日志并报告根因，不盲目重试。
10. 执行 npx prisma validate、npm run typecheck 和 npm test。完整回归需要时再执行 lint、隔离集成测试和 build。
11. 最终报告实际完成项、失败项、跳过项、访问地址和后续手工步骤。没有真实执行 OAuth、GitHub 同步或 AI 请求时，不得宣称这些外部链路已验收。

边界：不执行 git push，不提交 .env，不输出任何密钥，不擅自启用周期同步，不批量调用付费 AI，不删除数据库，不为了通过安装而修改业务代码或测试。
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run dev:all` | 前台同时启动 Web 与 Analysis Worker |
| `npm run dev:desktop` | 检查环境并启动桌面 Web、分析 Worker、自动化 Worker |
| `npm run dev:desktop:stop` | 停止桌面启动器管理的进程 |
| `npm run worker` | 单独启动 Analysis Worker |
| `npm run worker:automation` | 单独启动 Automation Worker |
| `npm run db:deploy` | 应用版本化 migrations 并验证关键结构 |
| `npm run db:baseline` | 对符合条件的旧 `db push` 数据库执行只读 baseline 检查 |
| `npm run typecheck` | TypeScript `--noEmit` |
| `npm test` | 无真实外部凭据的单元测试 |
| `npm run test:integration` | 使用隔离 PostgreSQL 数据库的集成测试 |
| `npm run lint` / `npm run build` | ESLint / Next.js production build |

桌面启动器使用 `.run/*.json` 记录 PID，日志位于 `logs/web*.log`、`logs/worker*.log` 和 `logs/automation*.log`。

## 功能边界与故障排查

| 现象 | 优先检查 |
|---|---|
| Docker 命令失败 | Docker Desktop 是否启动；`docker version` 是否同时包含 Client 和 Server |
| 页面能打开但无法登录 | OAuth callback、Client ID / Secret、`AUTH_SECRET` 和 `AUTH_URL` 是否匹配 |
| 新 Token 写入失败 | `TOKEN_ENCRYPTION_KEY` 是否为有效的 base64 32-byte key |
| 资产一直 `pending` | Analysis Worker 是否运行，以及 `logs/worker*.log` 是否有错误 |
| 摘要成功但语义搜索不可用 | Embedding provider 是否支持固定的 `text-embedding-3-small` / 1536 维 |
| migration 状态异常 | 先停止启动流程并阅读维护指南；不要用 reset 或强制 `db push` 掩盖问题 |
| 端口 / 容器已存在 | 先确认是否为本项目既有实例；不要直接删除容器、Volume 或其他进程 |

当前明确边界：

- **依赖分析未实现**；完整公开分享也不是当前能力。
- 知识资产提取依赖 Worker 与真实 LLM；批量执行前先评估 API 配额和费用。
- 真实 OAuth、GitHub 同步、LLM 和 Embedding 需要各自验收，不能由单元测试或 Mock 结果代替。
- 旧 `db push` 数据库升级、存量 Token 加密迁移、备份恢复和密钥轮换必须按维护指南单独执行。
- 项目处于阶段性封板与维护状态，后续以缺陷、安全和必要兼容性修复为主。

## 文档导航

- [项目维护指南](docs/PROJECT_MAINTENANCE_GUIDE.md)：部署、migration、备份恢复、密钥轮换和故障排查。
- [架构说明](docs/ARCHITECTURE.md)：系统图、数据流、实体关系和 Web / Worker 职责。
- [开发路线图](docs/DEVELOPMENT_ROADMAP.md)：历史阶段记录与后续事项。

## 安全说明

真实 OAuth Secret、API Key、Access Token、`.env`、数据库备份、日志和 PID 文件不得进入版本控制或公开 issue。GitHub Actions 使用临时测试配置，不使用真实业务凭据；远程 CI 状态以顶部 badge 和 Actions 页面为准。
