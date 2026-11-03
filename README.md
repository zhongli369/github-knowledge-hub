# GitHub Knowledge Hub

个人 GitHub 知识库：**同步仓库 → AI 摘要 → 代码资产提取 → 语义/全文混合搜索 → 收藏整理**。

架构为 **Next.js 单体 Web + 独立分析 Worker + PostgreSQL/pgvector**。项目目前主要面向个人本地使用，尚不具备开箱即用的生产部署和完整自动化验收。

## 文档导航

- [项目维护指南](docs/PROJECT_MAINTENANCE_GUIDE.md)：功能、版本、部署、调用链、环境变量、技术债和故障排查。
- [架构说明](docs/ARCHITECTURE.md)：系统图、数据流、实体关系、Web/Worker 职责边界。
- [开发路线图](docs/DEVELOPMENT_ROADMAP.md)：P0/P1/P2 现状、问题、方案与验收标准。

> 文档中的“源码已实现”不等于当前环境已完成端到端验证。真实验证范围和未验证功能见维护指南。

## 功能状态

| 模块 | 状态 | 说明 |
|---|---|---|
| GitHub OAuth 登录 | 源码已接通 | Auth.js + Prisma Adapter |
| 我的仓库 / Starred 同步 | 源码已接通 | Octokit + retry/throttling |
| Library 搜索、筛选、排序 | 源码已接通 | 笔记、状态、摘要和 Topic 管理 |
| AI 仓库摘要、缓存、重试 | 源码已接通 | Server Action 同步执行，支持批量顺序生成 |
| 知识资产提取 | 源码已接通 | **必须独立运行 Worker** |
| 资产向量搜索、相似推荐 | 源码已接通 | 依赖可用 Embedding 配置 |
| Discover 三模式搜索 | 部分可用 | keyword/hybrid 依赖 P0 全文搜索 schema 修复 |
| Collections | 部分实现 | 创建、删除、添加/移除资产；无编辑和完整分享 |
| Analyses | 部分实现 | 有历史与筛选；Token/耗时遥测未采集 |
| 依赖分析 | 未实现 | 当前函数明确抛出未实现异常 |

## 技术栈

当前实际安装的核心版本：Next.js 15.5.18 · React 19.2.6 · TypeScript 5.9.3 · Prisma 6.19.3 · PostgreSQL 17 + pgvector · Auth.js v5 · Octokit 21 · OpenAI SDK 4 · Tailwind CSS 4 · shadcn/ui · tsx。

## 快速开始：Windows + Docker

### 1. 前置条件

- Node.js 22+（当前开发机使用 Node.js 24）。
- Docker Desktop。
- GitHub OAuth App。
- 如需 AI 摘要，准备 OpenAI-compatible LLM 配置；如需语义搜索，准备兼容的 Embedding provider。

### 2. 安装和配置

```bash
cd F:\Claude\ClaudeCodeProject\GithubKnowledgeHub
npm install
Copy-Item .env.example .env
```

编辑本地 `.env`，至少配置：

```env
DATABASE_URL=
AUTH_SECRET=
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
```

Embedding 可单独设置 `EMBEDDING_API_KEY` 和 `EMBEDDING_BASE_URL`。真实 `.env` 不得提交 Git。

本地 GitHub OAuth 配置：

- Homepage URL：`http://localhost:3000`
- Callback URL：`http://localhost:3000/api/auth/callback/github`

### 3. 启动数据库

```bash
docker compose up -d
npx prisma validate
```

数据库包含 PostgreSQL 17 + pgvector，数据保存在 Docker Volume `pgdata`。

对于**确认可写的全新开发数据库**，旧流程可使用 `npx prisma db push` 初始化 Prisma schema；已有数据或生产环境不得盲目执行。全文搜索手写迁移目前存在 P0 问题，修复和验收方法见维护指南，不能只重复执行 `IF NOT EXISTS` SQL 就认定成功。

### 4. 启动 Web 和 Worker

```bash
npm run dev:all
```

或分别启动：

```bash
npm run dev
npm run worker
```

打开 [http://localhost:3000](http://localhost:3000)。

**Worker 提示：** 仓库摘要当前主要同步执行，不依赖 Worker；知识资产提取依赖 Worker。如果只启动 Web，提取任务会保持 `pending`。

### 5. 桌面快捷方式

Windows 桌面 `GitHub Knowledge Hub` 快捷方式调用 `scripts/start-desktop.ps1`，自动启动 Docker、PostgreSQL 和 Next.js，并在页面可访问后打开浏览器。

整理时该快捷方式只启动 Web，资产提取仍需另开终端执行 `npm run worker`。脚本含 Prisma schema 同步行为，已有重要数据时应先阅读维护指南并评估启动脚本。

### 6. WSL 旧路线

```bash
npm run dev:local
```

该路线调用 `scripts/start-dev.ps1`，依赖 WSL PostgreSQL。当前开发机没有可用 WSL Linux 发行版，因此使用 Docker。WSL 与 Docker 数据库不共享数据。

## npm scripts

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run dev:local` | WSL PostgreSQL 旧一键启动 |
| `npm run worker` | 启动后台分析 Worker |
| `npm run dev:all` | 同时启动 Next.js 和 Worker，不自动启动数据库 |
| `npm run build` | Next.js 生产构建 |
| `npm run start` | 启动生产 Web |
| `npm run lint` | 项目声明的 ESLint 命令，实际兼容性以验证结果为准 |
| `npm run db:push` | Prisma schema 同步；已有数据环境慎用 |
| `npm run db:generate` | 生成 Prisma Client |
| `npm run db:studio` | Prisma Studio |

## 代码导航

```text
src/app/                 页面、布局、Auth API
src/actions/             Server Actions
src/services/github/     GitHub API 服务
src/services/llm/        摘要、Embedding、搜索、分析历史
src/services/knowledge/  知识资产提取
src/services/intake/     Analysis 入队
src/lib/                 Prisma/OpenAI/GitHub 客户端和工具
workers/                 独立分析 Worker
prisma/                  schema 与全文搜索 SQL
scripts/                 启动和回填脚本
docs/                    维护、架构和路线图
```

## 验证与安全

恢复开发时至少执行：

```bash
npx tsc --noEmit
npx prisma validate
npm run build
```

ESLint、自动化测试和 CI 的现状见路线图。数据库测试必须使用独立测试库，禁止用真实个人数据执行 reset、破坏性 migration 或 `docker compose down -v`。

真实 OAuth Secret、API Key、Access Token、数据库备份和本地 `.env` 不得进入版本控制。

## 当前优先事项

1. Git 与私有远程备份、安全审计。
2. 修复全文搜索 generated column/GIN 和 Prisma migration 管理。
3. 建立启动与核心 smoke test。
4. Token 加密、Worker 原子领取和 CI。
5. 再补 difficulty、遥测、收藏集和摘要执行链。

详细验收标准见 [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md)。
