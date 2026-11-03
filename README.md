# GitHub Knowledge Hub

个人 GitHub 知识库：**同步仓库 → AI 摘要 → 代码资产提取 → 语义/全文混合搜索 → 收藏整理**。

架构为 **Next.js 单体 Web + 独立分析 Worker + PostgreSQL/pgvector**。项目主要面向个人本地使用；数据库 migration、核心回归测试和桌面启动已建立，但仍不是开箱即用的生产部署方案。

## 文档导航

- [项目维护指南](docs/PROJECT_MAINTENANCE_GUIDE.md)：功能、部署、migration、备份恢复、验证范围和故障排查。
- [架构说明](docs/ARCHITECTURE.md)：系统图、数据流、实体关系、Web/Worker 职责边界。
- [开发路线图](docs/DEVELOPMENT_ROADMAP.md)：已完成的 P0 和后续 P1/P2 工作。

> “源码已实现”不等于真实外部服务已验收。真实 OAuth、LLM 和 Embedding 的验证边界见维护指南。

## 功能状态

| 模块 | 状态 | 说明 |
|---|---|---|
| GitHub OAuth 登录 | 源码已接通 | Auth.js + Prisma Adapter；本轮未重跑真实 OAuth 回调 |
| 我的仓库 / Starred 同步 | 源码已接通 | Octokit + retry/throttling |
| Library 搜索、筛选、排序 | 源码已接通 | 笔记、状态、摘要和 Topic 管理 |
| AI 仓库摘要、缓存、重试 | 源码已接通 | Server Action 同步执行，支持批量顺序生成 |
| 知识资产提取 | 源码已接通 | **必须运行 Worker**；本轮 Worker 链使用 Mock 测试 |
| 资产向量搜索、相似推荐 | 源码已接通 | 依赖可用 Embedding 配置 |
| Discover 三模式搜索 | 隔离测试通过 | keyword/hybrid/semantic、筛选、用户隔离；真实 semantic 仍需 provider |
| Collections | 部分实现 | 创建、删除、添加/移除资产；无编辑和完整分享 |
| Analyses | 部分实现 | 有历史与筛选；Token/耗时遥测未采集 |
| 依赖分析 | 未实现 | 当前函数明确抛出未实现异常 |

## 技术栈

当前实际安装的核心版本：Next.js 15.5.18 · React 19.2.6 · TypeScript 5.9.3 · Prisma 6.19.3 · PostgreSQL 17 + pgvector · Auth.js v5 · Octokit 21 · OpenAI SDK 4 · Tailwind CSS 4 · shadcn/ui · tsx · Vitest 3。

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

### 3. 初始化或升级数据库

全新数据库：

```bash
docker compose up -d
npm run db:deploy
```

既有 `db push` 数据库不能直接套用首次 migration。先备份并完成隔离恢复演练，再执行：

```bash
npm run db:baseline       # 只读安全检查，不写入 migration 历史
npm run db:baseline:apply # 检查通过后标记初始基线并应用增量 migration
```

**当前真实 Docker 数据库已完成 baseline 和两条 migration，不要重复 baseline。** 日常升级使用 `npm run db:deploy`。详细条件、备份和恢复命令见维护指南。

### 4. 启动 Web 和 Worker

推荐桌面进程方式：

```bash
npm run dev:desktop
npm run dev:desktop:stop
```

启动器只会执行 `prisma validate` 和只读的 `prisma migrate status`，**不会执行 `db push`、`migrate deploy` 或创建扩展**。Web 与 Worker 分别使用 `.run/*.json` PID 记录和 `logs/web*.log`、`logs/worker*.log`。

也可在前台同时运行：

```bash
npm run dev:all
```

或分别启动 `npm run dev` 与 `npm run worker`。打开 [http://localhost:3000](http://localhost:3000)。

**Worker 提示：** 仓库摘要当前主要同步执行，不依赖 Worker；知识资产提取依赖 Worker。如果只启动 Web，提取任务会保持 `pending`。

### 5. 桌面快捷方式

Windows 桌面 `GitHub Knowledge Hub` 快捷方式调用 `scripts/start-desktop.ps1`，自动检查 Docker/PostgreSQL、migration 状态，启动 Web 和 Worker，并在页面可访问后打开浏览器。重复启动会复用现有实例。

### 6. WSL 旧路线

```bash
npm run dev:local
```

该路线调用 `scripts/start-dev.ps1`，依赖 WSL PostgreSQL。当前开发机没有可用 WSL Linux 发行版，因此使用 Docker。WSL 与 Docker 数据库不共享数据；旧启动器同样不再自动修改 schema。

## npm scripts

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run dev:all` | 前台同时启动 Next.js 和 Worker |
| `npm run dev:desktop` / `dev:desktop:stop` | 启动/停止脚本管理的桌面 Web 和 Worker |
| `npm run dev:local` | WSL PostgreSQL 旧一键启动 |
| `npm run worker` | 启动后台分析 Worker |
| `npm run typecheck` | TypeScript `--noEmit` |
| `npm test` | 无数据库、无外部凭据的单元测试 |
| `npm run test:integration` | 在唯一 `gkh_test_*` 隔离库运行 migration/search/startup 测试 |
| `npm run build` / `start` | Next.js 生产构建 / 启动 |
| `npm run lint` | ESLint；忽略构建产物、本地工具和日志 |
| `npm run db:deploy` | 应用版本化 migrations 并验证 generated column/GIN |
| `npm run db:baseline` / `db:baseline:apply` | 旧 `db push` 环境的安全检查 / 显式 baseline |
| `npm run db:migrate` | 后续开发新 migration；先审查 diff，禁止用于绕过基线 |
| `npm run db:push` | 保留的 Prisma 命令；不作为日常启动或既有数据升级方式 |
| `npm run db:generate` / `db:studio` | 生成 Prisma Client / 打开 Studio |

## 代码导航

```text
src/app/                 页面、布局、Auth API
src/actions/             Server Actions
src/services/github/     GitHub API 服务
src/services/llm/        摘要、Embedding、搜索、分析历史
src/services/knowledge/  知识资产提取
src/lib/                 Prisma/OpenAI/GitHub 客户端和工具
workers/                 独立分析 Worker
prisma/migrations/       完整基线与 generated searchVector/GIN migration
scripts/                 启动、停止、migration 和隔离测试工具
tests/unit/              无网络单元测试
tests/integration/       隔离 PostgreSQL 与启动测试
docs/                    维护、架构和路线图
```

## 验证与安全

```bash
npm run typecheck
npx prisma validate
npm run lint
npm test
npm run test:integration
npm run build
```

集成测试只从本地连接串派生唯一 `gkh_test_*` 数据库，创建前校验名称，结束后仅删除本次创建的测试库；不会 reset 或清空真实开发库。真实 OAuth/LLM 端到端测试必须单独人工验收，不能因缺少凭据而伪造通过。

真实 OAuth Secret、API Key、Access Token、数据库备份和本地 `.env` 不得进入版本控制。`db-backups/`、日志、PID 和测试产物均被 Git 忽略。

## 当前优先事项

1. GitHub OAuth Token 写入加密与存量迁移。
2. Worker 数据库原子领取、幂等和租约恢复。
3. GitHub Actions CI。
4. difficulty、遥测、收藏集和摘要执行链完善。

详细状态与验收标准见 [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md)。
