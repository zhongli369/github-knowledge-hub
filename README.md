# GitHub Knowledge Hub

[![CI](https://github.com/zhongli369/github-knowledge-hub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zhongli369/github-knowledge-hub/actions/workflows/ci.yml?query=branch%3Amain)

个人 GitHub 知识库：**同步仓库 → AI 摘要 → 代码资产提取 → 语义/全文混合搜索 → 收藏整理**。

架构为 **Next.js 单体 Web + 独立分析 Worker + PostgreSQL/pgvector**。项目主要面向个人本地使用；数据库 migration、核心回归测试和桌面启动已建立，但仍不是开箱即用的生产部署方案。

## 当前状态

截至 **2026-11-04**：

- `main` 已包含 Repository 多用户隔离、入队归属校验、Worker lease/fencing/超时恢复、GitHub 错误分类、Token v2 AAD 加密和隔离测试基础设施。
- 本地集中验证通过：TypeScript、Prisma validate、ESLint、**13 个文件 / 212 项单元测试**、**8 个文件 / 59 项隔离集成测试**，以及 Next.js production build。
- 真实 Docker 数据库已完成 baseline 和 **4 条 migration**；`prisma migrate status` 为 up to date，桌面 Web + Worker 启动及 `http://localhost:3000` 可用性已验证。
- 真实存量 Account Token 仍未迁移；真实 OAuth、GitHub 同步、LLM 和 Embedding 外部服务仍需单独人工验收。
- GitHub Actions 的最新状态以顶部 CI badge 和 Actions 页面为准；本地验证不替代远程 CI 结论。

## 文档导航

- [项目维护指南](docs/PROJECT_MAINTENANCE_GUIDE.md)：功能、部署、migration、备份恢复、验证范围和故障排查。
- [架构说明](docs/ARCHITECTURE.md)：系统图、数据流、实体关系、Web/Worker 职责边界。
- [开发路线图](docs/DEVELOPMENT_ROADMAP.md)：阶段状态与后续工作。

> “源码已实现”不等于真实外部服务已验收。真实 OAuth、LLM 和 Embedding 的验证边界见维护指南。

## 功能状态

| 模块 | 状态 | 说明 |
|---|---|---|
| GitHub OAuth 登录 | 源码已接通 | Auth.js + 加密 Prisma Adapter；真实 OAuth 回调/重新授权未重验 |
| OAuth Token 存储 | 新写入已加密 | AES-256-GCM v2 AAD 绑定 Account/字段上下文；兼容 v1 与旧密钥轮换；真实存量 Token 尚未迁移 |
| Repository 用户隔离 | 真实 migration 完成 | `(userId, githubId/fullName)` 唯一、入队 ownership gate、active Analysis 防重；双用户同步同一 GitHub 仓库已通过 PostgreSQL 测试 |
| 我的仓库 / Starred 同步 | 源码已接通 | Octokit + retry/throttling；仅 404 表示资源缺失，truncated Tree 显式失败；真实同步未在本轮重验 |
| Library 搜索、筛选、排序 | 源码已接通 | 笔记、状态、摘要和 Topic 管理，查询按当前用户隔离 |
| AI 仓库摘要、缓存、重试 | 源码已接通 | Server Action 同步执行，支持批量顺序生成；direct path 有有限恢复租约和 stale-write 防护 |
| 知识资产提取 | 隔离测试通过 | **必须运行 Worker**；外部 GitHub/LLM 在测试中 Mock |
| Worker 可靠性 | 隔离 PostgreSQL 测试通过 | 原子领取、NULL/过期 lease 回收、heartbeat、超时、有界重试、三任务并发池和 attempts fencing |
| 资产向量搜索、相似推荐 | 源码已接通 | 依赖可用 Embedding 配置；真实 provider 未在本轮重验 |
| Discover 三模式搜索 | 隔离测试通过 | keyword/hybrid/semantic、分页、筛选和用户隔离；真实 semantic 仍需 provider |
| Collections | 源码已接通 | 创建、删除、重命名、描述编辑、批量添加/移除和排序；无完整分享 |
| Analyses | 源码已接通 | 历史与筛选；摘要链路已采集 `tokensUsed` / `durationMs`，真实 provider 数据未重验 |
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
TOKEN_ENCRYPTION_KEY=
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
```

`TOKEN_ENCRYPTION_KEY` 必须是 base64 编码的 32-byte 随机 key，并跨重启稳定保存。轮换时把旧 key 放入 `TOKEN_ENCRYPTION_KEY_PREV`（仅用于解密），旧密文全部重加密前不得删除旧 key。当前本地 `.env` 已持久配置有效 key，但真实存量 Account Token 尚未迁移。

存量 Token 迁移默认只读：

```bash
npx tsx scripts/migrate-token-encryption.mjs           # dry-run
npx tsx scripts/migrate-token-encryption.mjs --execute # 明确执行；先备份并核对 dry-run
```

Embedding 可单独设置 `EMBEDDING_API_KEY` 和 `EMBEDDING_BASE_URL`。真实 `.env`、Token key 和数据库备份不得提交 Git。

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

**当前真实 Docker 数据库已完成 baseline 和四条 migration：init、searchVector、Worker leasing、Repository 用户隔离；不要重复 baseline。** 日常升级使用 `npm run db:deploy`。详细条件、备份和恢复命令见维护指南。

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

P3 自动同步在 `/automation` 配置，调度默认停用；启用周期同步或自动 AI 分析前，分别运行 `npm run worker:automation` 与 `npm run worker`。手动“立即执行”由 Web 发起同步，但自动摘要和资产提取仍由分析 Worker 消费。同步按 Star 状态、`pushedAt`、HEAD SHA 和内容指纹去重，取消 Star 只标记 `unstarredAt`，不会删除已有知识资产。

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
| `npm run worker:automation` | 启动独立的周期同步调度 Worker |
| `npm run typecheck` | TypeScript `--noEmit` |
| `npm test` | 无数据库、无外部凭据的单元测试；2026-11-05 集中验证为 278 个通过 |
| `npm run test:integration` | 每个测试文件使用独立 `gkh_test_*` 数据库；2026-11-05 为 61 个通过 |
| `npm run build` / `start` | Next.js 生产构建 / 启动 |
| `npm run lint` | ESLint；忽略构建产物、本地工具和日志 |
| `npm run db:deploy` | 应用五条版本化 migrations，并验证 generated/GIN、leasing、用户维度唯一索引、active Analysis 防重和单用户运行中 SyncRun 约束 |
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
src/lib/                 Prisma/OpenAI/GitHub 客户端、加密 Adapter 和 Token 工具
src/services/analysis/   Worker 租约、自动分析去重与内容指纹
src/services/automation/ 周期调度、配置和运行状态
src/services/sync/       Starred 仓库增量同步
workers/                 独立分析与自动同步 Worker
prisma/migrations/       init、searchVector/GIN、leasing、用户隔离、P3 自动同步
scripts/                 启动、停止、migration、存量 Token 迁移和隔离测试工具
tests/unit/              无网络单元测试
tests/integration/       隔离 PostgreSQL 与启动测试
.github/workflows/       GitHub Actions 静态检查/build 与集成测试
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

GitHub Actions 在 push / pull_request 时运行两个 Ubuntu jobs：`check` 执行 npm ci、Prisma、typecheck、ESLint、单元测试和 build；`integration` 启动临时 PostgreSQL/pgvector，执行 migration deploy 与集成测试。CI 不使用真实业务凭据，测试 Token 加密密钥由 `openssl` 动态生成，外部 AI 使用 Mock。远程状态以实际 Actions 记录为准。

真实 OAuth Secret、API Key、Access Token、数据库备份和本地 `.env` 不得进入版本控制。`db-backups/`、日志、PID 和测试产物均被 Git 忽略。

## 当前优先事项

1. 对真实存量 Account Token 先执行 dry-run 和备份审查，只有明确批准后才执行加密迁移。
2. 分别验收真实 OAuth、GitHub 仓库同步、LLM 和 Embedding 外部服务，不能以 Mock 测试替代。
3. 继续保持日常启动与 schema 维护分离；真实 migration 必须先备份、审查冲突并在隔离库演练。

详细状态与验收标准见 [开发路线图](docs/DEVELOPMENT_ROADMAP.md)。
