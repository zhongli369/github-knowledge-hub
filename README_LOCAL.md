# GitHub Knowledge Hub — 本地开发指南

## 1. 前提条件

- Node.js ≥ 22
- WSL (Ubuntu) 或 Docker（用于运行 PostgreSQL + pgvector）
- 如果用 WSL：PostgreSQL 16+ 已安装并配置 pgvector 扩展

## 2. 一键启动（推荐）

如果你用的是 WSL + PostgreSQL，直接运行：

```bash
npm run dev:local
```

脚本会自动完成：
1. 启动 WSL 里的 PostgreSQL（无需手动输入 sudo 密码）
2. 检查数据库和 pgvector 扩展
3. 检查环境变量，缺失时交互式补齐
4. 执行 prisma validate + prisma db push
5. 启动 Next.js 开发服务器

**首次运行会提示：**
- 输入 DeepSeek API Key（或 OpenAI Key）
- 如缺少 GitHub OAuth 配置，会提示去创建 OAuth App
- sudo 密码仅临时输入，**不保存到磁盘**

**关键行为：**
- API Key / Secret 写入 `.env.local`（已在 `.gitignore`，不会提交 git）
- sudo 密码通过 `Read-Host -AsSecureString` 输入，用完即弃
- 不会打印任何 secret 到控制台

## 3. 手动启动（Docker 用户）

如果你用 Docker 而不是 WSL PostgreSQL：

项目根目录已有 `docker-compose.yml`，直接启动：

```bash
docker compose up -d
```

这将启动一个 pgvector/pgvector:pg17 容器，配置如下：

| 参数 | 值 |
|---|---|
| 端口 | `5432:5432` |
| 用户名 | `postgres` |
| 密码 | `postgres` |
| 数据库名 | `github_knowledge_hub` |
| 数据持久化 | Docker volume `pgdata` |

验证数据库已就绪：

```bash
docker compose ps
# 状态应为 "Up" 或 "running"
```

停止/清理（可选）：

```bash
docker compose down        # 停止容器，保留数据卷
docker compose down -v     # 停止容器并删除数据卷（重置数据库）
```

## 4. .env 配置

```bash
cp .env.example .env
```

编辑 `.env`，确保以下必填项正确：

```env
# ── 数据库（Docker 用户无需修改）───────────────────────────────
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/github_knowledge_hub?schema=public"

# ── Auth.js（运行 npx auth secret 生成）────────────────────────
AUTH_SECRET="生成一段至少 32 字符的随机字符串"

# ── GitHub OAuth（见第 4 步）───────────────────────────────────
AUTH_GITHUB_ID="你的 Client ID"
AUTH_GITHUB_SECRET="你的 Client Secret"

# ── 以下可选，Phase 1–4 不需要 ─────────────────────────────────
GITHUB_TOKEN=""
OPENAI_API_KEY=""
```

生成 `AUTH_SECRET`：

```bash
npx auth secret
# 将输出的值复制到 .env 的 AUTH_SECRET
```

## 5. 创建 GitHub OAuth App

1. 打开 https://github.com/settings/developers/new
2. 填写表单：

   | 字段 | 值 |
   |---|---|
   | Application name | `GitHub Knowledge Hub (local)` |
   | Homepage URL | `http://localhost:3000` |
   | Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

3. 点击 **Register application**
4. 点击 **Generate a new client secret**
5. 将 **Client ID** 复制到 `.env` 的 `AUTH_GITHUB_ID`
6. 将 **Client Secret** 复制到 `.env` 的 `AUTH_GITHUB_SECRET`

> **注意**：callback URL 必须与 GitHub OAuth App 的设置完全一致，包括协议（http/https）、域名（localhost）和路径。

## 6. 初始化数据库

```bash
npx prisma db push
```

成功输出示例：

```
✔ Generated Prisma Client
...
Your database is now in sync with your Prisma schema.
```

## 7. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 8. 端到端验证流程

按顺序执行以下步骤，确认整个主链跑通：

```
Step 1: 浏览器打开 http://localhost:3000
        → 自动跳转到 /login 页面

Step 2: 点击 "Continue with GitHub"
        → 跳转 GitHub 授权页面

Step 3: 授权后
        → 跳回 / 仪表盘
        → 左侧侧边栏显示用户名和头像

Step 4: 左侧导航 → Browse Repos
        → 点击 "Sync Starred" 按钮
        → 等待几秒（取决于 starred 仓库数量）
        → 仓库列表出现在页面中

Step 5: 左侧导航 → Knowledge Library
        → 查看刚同步的仓库列表
        → 点击笔记编辑图标 → 输入笔记 → Save
        → 切换 Status 下拉（New / Analyzing / Active / Archived）
```

如果某个步骤失败，参考下方的常见问题。

## 9. 常见问题

### 端口 5432 已被占用

```
Error: port 5432 already in use
```

**原因**：本地已运行其他 PostgreSQL 实例。

**解决**：

```bash
# 查看是谁占用了 5432
netstat -ano | findstr :5432

# 停止本地 PostgreSQL 服务（Windows）
net stop postgresql-x64-17

# 或者修改 docker-compose.yml 使用其他端口：
#   ports:
#     - "5433:5432"
# 同时修改 .env：
#   DATABASE_URL="postgresql://postgres:postgres@localhost:5433/github_knowledge_hub?schema=public"
```

### OAuth callback mismatch / redirect_uri_mismatch

```
Error: redirect_uri_mismatch
```

**原因**：GitHub OAuth App 的 callback URL 配置与实际不符。

**解决**：
1. 确认 `.env` 中没有设置 `AUTH_URL`（开发环境让它自动推断）
2. 检查 GitHub OAuth App 设置页：https://github.com/settings/developers
3. Authorization callback URL 必须填写为：`http://localhost:3000/api/auth/callback/github`
4. 注意 `http` 而不是 `https`，端口不是其他值

### DATABASE_URL 连接失败

```
Error: Can't reach database server at localhost:5432
```

**解决**：
1. 确认 Docker 容器正在运行：`docker compose ps`
2. 确认 DATABASE_URL 格式正确（无多余空格、引号）
3. 如果容器刚刚启动，等待 5-10 秒让 PostgreSQL 完全就绪

### pgvector extension missing

```
Error: extension "vector" is not available
```

**原因**：数据库未安装 pgvector 扩展。

**解决**：
- 确认使用的是 `pgvector/pgvector:pg17` 镜像而不是普通的 `postgres:17` 镜像
- `docker compose down -v` 删除旧数据卷后重新 `docker compose up -d`

### 数据库需要完全重置

```bash
# 删除容器和数据卷
docker compose down -v

# 重新创建
docker compose up -d

# 等待 5 秒让 PG 就绪，然后推送 schema
npx prisma db push
```

### Sync Starred 点击后无反应

**原因**：通常是因为 GitHub OAuth token 缺少 `repo` scope。

**解决**：
1. 退出登录（点击左下角用户菜单 → Log out）
2. 重新登录时会请求新的 scope
3. 检查 `src/auth.ts` 中 GitHub provider 的 scope 是否包含 `repo`

## 10. 项目结构

```
src/
├── app/
│   ├── (dashboard)/
│   │   ├── page.tsx              # 仪表盘首页
│   │   ├── layout.tsx             # 仪表盘 Shell
│   │   ├── repos/                 # 仓库浏览 + 同步
│   │   ├── library/               # 知识库（笔记 + 状态）
│   │   ├── discover/              # 发现（占位）
│   │   └── analyses/              # 分析历史（占位）
│   ├── login/page.tsx             # GitHub 登录页
│   └── api/auth/[...nextauth]/    # Auth.js API 路由
├── actions/repos.ts               # Server Actions
├── auth.ts                        # Auth.js 配置
├── middleware.ts                  # 路由保护
├── components/                    # UI 组件
├── lib/                           # 工具库
├── services/github/               # GitHub API 服务层
├── services/llm/                  # Phase 5 stubs
└── services/knowledge/            # Phase 5 stubs

prisma/schema.prisma               # 数据模型
workers/analysis-worker.ts         # Phase 5 stub
```

## 11. OAuth 验证状态

> ✅ 真实 GitHub OAuth E2E 已通过（2026-05-27）。
> 完整登录 → 授权 → 回调 → 仪表盘流程验证成功。

## 12. Phase 状态

| Phase | 内容 | 状态 |
|---|---|---|
| 1 | 项目脚手架 + GitHub OAuth 登录 | ✅ Accepted |
| 2 | 数据库 Schema + pgvector | ✅ Accepted |
| 3 | GitHub API 服务层（Octokit + 同步） | ✅ Accepted |
| 4 | Library UI（笔记、状态、标签） | ✅ Accepted |
| 5 | Repo Summary MVP（LLM 摘要 + 缓存） | ✅ Accepted |
| 6 | Embedding / 语义搜索 / 推荐 | 🔜 后续 |
