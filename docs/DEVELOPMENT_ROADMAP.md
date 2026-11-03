# GitHub Knowledge Hub 开发路线图

> 基线日期：2026-11-03  
> 原则：先保证可恢复、可迁移、可验证，再扩展 AI 和分享功能。  
> 状态口径：“现状”描述任务开始时的代码/环境，不代表后续任务已经完成。

## 优先级定义

- **P0**：数据安全、版本恢复、数据库正确性和核心回归的阻塞项。
- **P1**：生产安全、并发可靠性、持续集成和文档一致性。
- **P2**：功能完整性、可观测性和使用体验。

---

## P0：必须先完成

### P0-1 Git 版本管理和仓库备份

**现状**

- 任务开始时项目目录没有 `.git`，缺少提交历史和远程备份。
- 项目包含真实本地 `.env`、构建产物、依赖目录及本地工具文件，不能直接全量上传。

**问题**

- 无法可靠比较变更、回滚错误提交或确认线上源码版本。
- 误提交真实 OAuth Secret、API Key、Access Token 或数据库备份会造成泄露。

**建议方案**

1. 初始化 `main` 分支，配置本地 Git 身份。
2. 完善 `.gitignore`，保留 `.env.example`，排除真实配置、依赖、构建缓存、数据库数据和临时文件。
3. 将 `prisma/migrations/` 重新纳入版本控制。
4. 对 staged 文件路径和内容做敏感信息扫描，不只依赖 `.gitignore`。
5. 使用当前认证账号创建或复用明确对应的 **Private** 仓库。
6. 非强制推送，核对本地/远程 Commit SHA、仓库所有者和 Private 可见性。

**验收标准**

- 本地有可读 Git 历史，默认/主分支明确。
- 远程仓库属于预期账号且为 Private。
- 远程 Commit SHA 与本地一致，关键源码和文档可在远程读取。
- staged/远程内容中没有真实凭据、数据库内容、Token 或大体积本地产物。
- 全程没有 force push、覆盖不相关仓库或删除历史。

### P0-2 PostgreSQL 全文搜索 generated column / GIN 修复

**现状**

- `prisma/migrations/hybrid-search.sql` 期望 `Repository.searchVector` 是 generated `tsvector`，并建立 GIN 索引。
- 当前 Docker 数据库只读检查结果：pgvector 已启用，但该列为普通 `tsvector`、`generated=NEVER`，GIN 索引不存在。
- SQL 使用 `ADD COLUMN IF NOT EXISTS`，对错误存在的普通列重跑不会完成转换。

**问题**

- keyword/hybrid 搜索可能无结果、报错或全表扫描。
- “SQL 执行成功”不能证明列定义和数据填充正确。
- Web 搜索代码和实际数据库状态不一致。

**建议方案**

1. 先对现有数据库做逻辑备份，并记录实际 schema；禁止在真实数据上直接试验。
2. 在独立测试库复现“普通 tsvector 已存在”的状态。
3. 编写显式、可审查的迁移，替换错误列并创建 generated 表达式和 GIN 索引；执行前评估依赖和锁影响。
4. 将 name、description、topics 的生成表达式与代码中的 `websearch_to_tsquery('english', ...)` 对齐。
5. 对已有仓库验证向量自动填充，对新增/更新仓库验证自动维护。
6. 将修复纳入标准 Prisma migration，不再依赖手工补跑孤立 SQL。

**验收标准**

- `information_schema.columns.is_generated = 'ALWAYS'`，生成表达式符合设计。
- `Repository_searchVector_idx` 存在且类型为 GIN。
- 已有及新增/更新 Repository 的 `searchVector` 自动填充。
- keyword、semantic、hybrid 三模式 smoke test 通过，且只返回当前用户数据。
- 在备份副本上演练过迁移和回滚，真实数据未被清空或重建。

### P0-3 Prisma migration 管理方案

**现状**

- 项目主要依赖 `prisma db push`。
- `prisma/migrations/` 曾被 `.gitignore` 忽略，目前只有手写 `hybrid-search.sql`，没有完整版本化迁移链。
- 桌面启动脚本会自动执行 `db push`。

**问题**

- 开发、测试、生产 schema 可能漂移。
- 启动 Web 可能隐式修改数据库。
- 手写 SQL 与 Prisma 管理的列定义互相影响，无法可靠回滚和审计。

**建议方案**

1. 将 migration 文件纳入 Git，不再忽略 `prisma/migrations/`。
2. 盘点各环境实际 schema，选择基线策略：新环境从 migrations 创建，既有环境通过备份副本完成 baseline。
3. 将 pgvector、generated column、GIN 等 Prisma 无法完整表达的 SQL 纳入显式 migration。
4. 开发使用受控 migration，部署使用 `prisma migrate deploy`；停止在应用启动时自动 `db push`。
5. 文档明确 migrate、回滚、备份和紧急恢复流程。

**验收标准**

- 全新测试数据库仅依靠版本化 migrations 即可得到完整 schema。
- 既有数据库的基线过程在副本上验证，无未预期 drop/reset。
- Web/Worker 启动不会自动修改 schema。
- migration SQL 进入 Git，CI 可在 PostgreSQL/pgvector 测试服务上重复执行。

### P0-4 项目启动与核心功能 smoke test

**现状**

- 整理时验证了 HTTP 登录页、TypeScript 和 Prisma validate，但没有完整 smoke test。
- 没有 `test` 脚本和现有自动化测试。

**问题**

- 无法快速判断数据库、OAuth、GitHub、LLM、Worker 和搜索变更是否破坏主链。
- “页面能打开”无法代表核心功能可用。

**建议方案**

建立分层 smoke test：

1. 静态：TypeScript、Prisma validate、ESLint、Next.js build。
2. 启动：PostgreSQL/pgvector、Web HTTP、登录页和受保护路由。
3. 数据库：版本化 migration、generated column、GIN、Repository CRUD。
4. 核心领域：笔记/状态、摘要缓存、收藏集、Analysis 状态机。
5. Worker：pending → running → completed/failed，资产提取幂等。
6. 搜索：keyword/semantic/hybrid、相似仓库/资产、用户隔离。
7. 外部服务使用独立测试账号/测试数据库；密钥只走安全环境，不写入测试快照。

**验收标准**

- 一条明确命令可运行本地 smoke test，失败时返回非零退出码。
- 测试使用独立可丢弃数据库，不触碰真实个人数据。
- 无外部凭据时，静态和无网络测试仍可运行；需要凭据的测试明确标记跳过而非伪造通过。
- 测试结果记录真实通过、失败和跳过数量。

---

## P1：安全性、可靠性和持续交付

### P1-1 GitHub OAuth Token 安全存储

**现状**

- Octokit 从 `Account.access_token` 获取用户 Token。
- `encryptToken()` 未发现调用方；`decryptToken()` 对 GitHub 格式 Token 直接按明文返回。

**问题**

- 数据库泄露可能直接暴露用户 GitHub 权限。
- 仅在使用时解密而没有写入加密，无法形成完整保护。

**建议方案**

1. 使用独立、可轮换的 Token 加密密钥和带版本号的密文格式。
2. 在 Account Token 首次写入、更新和刷新时加密；读取时统一解密。
3. 制定存量明文 Token 的惰性或批处理迁移，禁止日志输出 Token。
4. 限制数据库备份、错误报告和分析记录中的敏感字段。
5. 设计密钥轮换和失效恢复流程，不擅自轮换现有用户凭据。

**验收标准**

- 数据库和备份中不再出现可识别的 GitHub 明文 Token。
- 新旧密文版本读取、Token 更新和密钥轮换测试通过。
- 日志、异常、Git staged 内容和测试快照不包含 Token。

### P1-2 Worker 原子任务领取

**现状**

- Worker 先 `findFirst(pending)`，再按 id 更新为 running，注释称原子但存在两个独立操作。
- 单进程有并发限制，多进程之间没有互斥和租约恢复。

**问题**

- 多 Worker 可领取同一任务，重复调用 LLM、重复写资产或产生超额费用。
- Worker 崩溃后 running 任务可能永久卡住。

**建议方案**

1. 在单个 PostgreSQL 事务中使用锁定查询和条件更新，例如 `FOR UPDATE SKIP LOCKED` + `RETURNING`。
2. 更新时校验当前状态仍为 pending，并检查影响行数。
3. 增加 lease/heartbeat/attempt 和超时恢复策略。
4. 为资产写入和摘要写入设置幂等约束。

**验收标准**

- 多 Worker 并发测试中，同一 Analysis 只有一个领取者。
- 重复执行不会产生重复资产或重复扣费调用。
- 崩溃、超时、重试和 shutdown 测试通过，任务不会永久卡住。

### P1-3 自动化测试与 GitHub Actions CI

**现状**

- 无 test 脚本、未发现业务测试文件、无 GitHub Actions。
- TypeScript 和 Prisma validate 可运行，但缺乏统一质量门。

**问题**

- 回归依赖人工记忆，数据库和 Worker 问题容易进入主分支。

**建议方案**

1. 引入轻量测试运行器，优先测试服务层、权限、状态机和 SQL。
2. GitHub Actions 使用固定 Node.js 版本，执行 `npm ci`、typecheck、Prisma validate、lint、test、build。
3. 使用 PostgreSQL/pgvector 测试服务执行 migration 和数据库测试。
4. 按路径和密钥可用性拆分无网络测试与外部 E2E，不上传真实秘密。
5. 缓存依赖和构建产物，但不缓存真实 `.env` 或数据库。

**验收标准**

- 每个推送/PR 自动运行，失败能阻止合并。
- CI 日志不含秘密，测试数据库与真实环境隔离。
- 核心路径有稳定测试，跳过的外部测试有明确原因。

### P1-4 README、CLAUDE.md、环境变量文档同步

**现状**

- README 的 Phase 状态落后于源码。
- `.env.example` 仍写 Phase 5 未启用，部分变量说明与代码读取不一致。
- `src/lib/openai.ts` 仍有 stub 注释。
- 项目 `CLAUDE.md` 引用不存在的 `PROJECT_BRIEF.md` 和旧 Harness 路线。

**问题**

- 恢复开发时容易按旧文档选择错误启动、配置或架构路线。

**建议方案**

1. 以源码和实际验证为准更新 README、维护指南、架构文档和路线图。
2. 对齐 `.env.example` 与真实变量，模型硬编码和回退行为要明确。
3. 删除过期 stub/Phase 注释，保留真实限制。
4. 清理不存在的文档和已退役 Harness 引用，遵守更高优先级工作区规则。
5. 将文档链接和 Mermaid 检查纳入验证。

**验收标准**

- 新维护者仅按文档即可启动 Web/Worker，并知道哪些功能未验证。
- 环境变量模板不含真实值，名称和用途与代码一致。
- 文档内链接有效，Mermaid 可解析，旧 Phase 不再误导。

---

## P2：功能完整性

### P2-1 difficulty 字段真正持久化

**现状**：LLM JSON 包含 difficulty，但 `KnowledgeAsset` 创建时未保存；筛选 UI 和字段已存在。

**问题**：筛选无有效数据，旧资产也为空。

**建议方案**：定义枚举/允许值，结构化解析 LLM 结果，校验后写入；失败时为 null 而非伪造中级；提供可选回填。

**验收标准**：新资产正确保存 beginner/intermediate/advanced，非法值安全处理，筛选测试通过，旧数据策略明确。

### P2-2 tokensUsed / durationMs 遥测

**现状**：数据库和 Analyses UI 有字段，生成链未记录真实值。

**问题**：无法评估模型成本、性能和失败重试开销。

**建议方案**：在同步和 Worker 两条链统一计时，读取 provider usage（若提供），记录缺失原因，避免把多阶段用量混为一谈。

**验收标准**：成功/失败任务都有合理耗时；支持的 provider 记录真实 Token；无 usage 时明确为空；历史页展示与数据库一致。

### P2-3 收藏集编辑和分享

**现状**：支持创建、删除、添加/移除资产；不支持编辑，`isPublic` 没有完整分享链。

**问题**：收藏集长期维护不便，公开字段可能造成“已支持分享”的误解。

**建议方案**：先实现 owner 编辑；再单独设计只读分享 token/URL、过期撤销、私有资产防护和访问审计。若不计划分享，移除误导 UI/字段。

**验收标准**：owner 可编辑名称/描述，越权请求失败；分享链接只读、可撤销，不泄露私有仓库、笔记、Token 或其他用户资产。

### P2-4 摘要同步与队列执行链统一

**现状**：单个/批量摘要主要走同步 Server Action；Worker 也支持摘要，另有未接 UI 的入队 Actions。

**问题**：缓存、重试、状态和并发语义分散，批量任务容易受请求时长影响。

**建议方案**：确定统一用例层和幂等键；轻量单任务可同步，批量走队列；UI 只订阅统一 Analysis 状态；避免重复生成和重复 Embedding。

**验收标准**：单任务、批量、重试、缓存、Worker 重启行为一致；同一仓库不会无意义并发生成；UI 状态与数据库一致。

---

## 推荐实施顺序

1. Git/安全备份与敏感信息审计。
2. 在测试库修复全文搜索和 Prisma migration 基线。
3. 建立启动及核心 smoke test。
4. Token 加密与 Worker 原子领取。
5. CI 和文档一致性。
6. difficulty、遥测、收藏集和统一摘要链。

## 每项任务的完成定义

- 有真实验证输出，明确通过、失败和跳过。
- 不修改或清空真实个人数据库来“让测试通过”。
- 不上传真实秘密，不将旧问题包装成新问题。
- 文档、代码、migration 和实际部署状态一致。
- 变更可审查、可回滚，且不覆盖他人未提交工作。
