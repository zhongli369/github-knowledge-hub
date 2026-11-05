/**
 * 自动分类引擎 —— 编排层。
 *
 * 依赖主 Agent 合同中的 Prisma 新模型：CollectionRepository、
 * RepositoryClassification，以及 Collection.slug/kind、Repository 的新关系。
 * 集成测试（真实 DB）由主 Agent/Agent D 驱动；针对性单元测试使用纯函数 +
 * mock（见 tests/classification/）。
 *
 * 安全约束：
 * - 一切查询均以 userId 限定，禁止跨用户读写。
 * - 自动持久化只操作 source="auto" 且 excluded=false 的 CollectionRepository；
 *   source="manual" 或 excluded=true 永不覆盖/删除/重新加入。
 * - 单仓库失败显式返回 failed，不向批量调用抛异常。
 */

import { prisma } from "@/lib/prisma"
import { fetchRepoReadme } from "@/services/github"
import { CLASSIFIER_VERSION, computeRepoContentHash, extractSummaryText, hasSufficientCategorySignal } from "./fingerprint"
import { classifyDeterministic } from "./deterministic"
import { classifyWithLLM } from "./llm"
import { REPO_CATEGORY_DEFINITIONS, type RepoCategorySlug } from "./taxonomy"

// ── 公共类型 ────────────────────────────────────────────────────

export type ClassificationMode = "all" | "unclassified" | "reclassify"

export type ClassificationOutcome = {
  status: "classified" | "unclassified" | "skipped" | "failed"
  categorySlugs: string[]
  fromCache: boolean
  error?: string
}

export interface ClassificationBatchResult {
  total: number
  succeeded: number
  skipped: number
  failed: number
}

export interface BatchProgress {
  total: number
  processed: number
  succeeded: number
  skipped: number
  failed: number
}

export interface ClassifyRepositoryArgs {
  userId: string
  repositoryId: string
  /** true 时忽略缓存（hash/version 命中也不跳过），强制重算。 */
  force?: boolean
}

export interface ClassifyRepositoriesArgs {
  userId: string
  /**
   * all：处理全部，默认跳过「已 classified 且 hash/version 未变」。
   * unclassified：只处理没有成功指纹或 status != classified 的仓库。
   * reclassify：强制重算全部。
   */
  mode?: ClassificationMode
  /** 指定仓库子集（可选的幂等：去重、越权 id 自动忽略）。 */
  repositoryIds?: string[]
  force?: boolean
  onProgress?: (p: BatchProgress) => void | Promise<void>
}

// ── 集合创建与自动关系持久化 ────────────────────────────────────

/**
 * 为每个用户创建/补齐固定 category 集合（kind="category", slug=...）。
 * 保留旧的 custom 集合与 CollectionAsset，绝不删除/覆盖已有集合。
 */
export async function ensureCategoryCollections(userId: string): Promise<void> {
  const existing = await prisma.collection.findMany({
    where: { userId, kind: "category" },
    select: { slug: true },
  })
  const existingSlugs = new Set(existing.map((c) => c.slug).filter((s): s is string => Boolean(s)))
  const missing = REPO_CATEGORY_DEFINITIONS.filter((d) => !existingSlugs.has(d.slug))
  if (missing.length === 0) return

  await prisma.collection.createMany({
    data: missing.map((d) => ({
      userId,
      name: d.nameZh,
      description: d.descriptionZh,
      kind: "category" as const,
      slug: d.slug,
      isPublic: false,
    })),
    skipDuplicates: true, // 依赖 @@unique([userId, slug])
  })
}

/**
 * 把本次分类结果持久化为 CollectionRepository 自动关系。
 *
 * 规则：
 * - 只更新/删除 source="auto" 且 excluded=false 的行。
 * - source="manual" 或 excluded=true 的行永不覆盖/删除/重新加入。
 * - 自动重分时可删除「本次不再属于」且 source=auto 未排除的旧关系。
 */
export async function syncAutoCollectionLinks(
  userId: string,
  repositoryId: string,
  categories: RepoCategorySlug[],
  confidence?: number,
  reason?: string
): Promise<void> {
  await ensureCategoryCollections(userId)

  const categoryCollections = await prisma.collection.findMany({
    where: { userId, kind: "category" },
    select: { id: true, slug: true },
  })
  const slugToCollectionId = new Map<string, string>()
  for (const c of categoryCollections) {
    if (c.slug) slugToCollectionId.set(c.slug, c.id)
  }

  const targetIds = new Set<string>()
  for (const slug of categories) {
    const collectionId = slugToCollectionId.get(slug)
    if (collectionId) targetIds.add(collectionId)
  }

  const existingLinks = await prisma.collectionRepository.findMany({
    where: {
      repositoryId,
      collection: { userId, kind: "category" },
    },
    select: { id: true, collectionId: true, source: true, excluded: true },
  })

  const protectedCollectionIds = new Set<string>()
  const autoLinks = existingLinks.filter((link) => {
    if (link.source === "manual" || link.excluded === true) {
      protectedCollectionIds.add(link.collectionId)
      return false // manual/excluded 永不参与
    }
    return true
  })

  // 1) 更新的更新，本次不再属于的删除（均只作用于 auto/未排除）。
  for (const link of autoLinks) {
    if (targetIds.has(link.collectionId)) {
      await prisma.collectionRepository.updateMany({
        where: { id: link.id, source: "auto", excluded: false },
        data: { confidence: confidence ?? null, reason: reason ?? null },
      })
    } else {
      await prisma.collectionRepository.deleteMany({
        where: { id: link.id, source: "auto", excluded: false },
      })
    }
  }

  // 2) 补齐缺失目标关系；被 manual/excluded 占据的 collection 永不新增。
  const existingAutoIds = new Set(autoLinks.map((l) => l.collectionId))
  for (const collectionId of targetIds) {
    if (protectedCollectionIds.has(collectionId)) continue
    if (existingAutoIds.has(collectionId)) continue
    try {
      await prisma.collectionRepository.create({
        data: {
          collectionId,
          repositoryId,
          source: "auto",
          confidence: confidence ?? null,
          reason: reason ?? null,
        },
      })
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") continue // 并发建链幂等
      throw error
    }
  }
}

// ── 分类结果落库 ────────────────────────────────────────────────

async function persistClassification(input: {
  userId: string
  repositoryId: string
  contentHash: string
  status: "classified" | "unclassified" | "failed"
  categorySlugs: RepoCategorySlug[]
  error?: string
}): Promise<void> {
  const classifiedAt = input.status === "classified" ? new Date() : null
  await prisma.repositoryClassification.upsert({
    where: { repositoryId: input.repositoryId },
    create: {
      repositoryId: input.repositoryId,
      userId: input.userId,
      contentHash: input.contentHash,
      classifierVersion: CLASSIFIER_VERSION,
      status: input.status,
      categorySlugs: input.categorySlugs,
      error: input.error ?? null,
      classifiedAt,
    },
    update: {
      userId: input.userId,
      contentHash: input.contentHash,
      classifierVersion: CLASSIFIER_VERSION,
      status: input.status,
      categorySlugs: input.categorySlugs,
      error: input.error ?? null,
      classifiedAt,
    },
  })
}

function failedOutcome(error: string): ClassificationOutcome {
  return { status: "failed", categorySlugs: [], fromCache: false, error }
}

// ── 单仓库分类 ──────────────────────────────────────────────────

function shouldSkipCached(existing: { status: string; contentHash: string; classifierVersion: string }, hash: string, force: boolean): boolean {
  return (
    !force &&
    existing.status === "classified" &&
    existing.contentHash === hash &&
    existing.classifierVersion === CLASSIFIER_VERSION
  )
}

export async function classifyRepository(args: ClassifyRepositoryArgs): Promise<ClassificationOutcome> {
  const { userId, repositoryId, force = false } = args
  try {
    // 所有权边界：仓库必须属于该用户，否则视为失败（不抛出）。
    const repo = await prisma.repository.findFirst({
      where: { id: repositoryId, userId },
      select: {
        id: true,
        name: true,
        fullName: true,
        description: true,
        language: true,
        homepage: true,
        topics: true,
        stars: true,
        owner: true,
      },
    })
    if (!repo) {
      return failedOutcome("Repository not found or not owned by user")
    }

    // 复用已有 AI repo_summary，绝不重复生成摘要。
    const analysis = await prisma.analysis.findFirst({
      where: { repositoryId, userId, analysisType: "repo_summary", status: "completed" },
      orderBy: { createdAt: "desc" },
      select: { result: true },
    })
    const summaryText = extractSummaryText(analysis?.result)
    const hash = computeRepoContentHash({ ...repo, summaryText })

    // 缓存跳过：已 classified 且 hash/version 未变 → 不调用 AI。
    const existing = await prisma.repositoryClassification.findUnique({
      where: { repositoryId },
    })
    if (existing && existing.userId !== userId) {
      return failedOutcome("Classification row belongs to another user")
    }
    if (existing && shouldSkipCached(existing, hash, force)) {
      return {
        status: "skipped",
        categorySlugs: existing.categorySlugs ?? [],
        fromCache: true,
      }
    }

    // 构建分类输入（语言字段绝不参与分类，只做功能/用途）。
    const deterministicInput = {
      name: repo.name,
      fullName: repo.fullName,
      description: repo.description,
      topics: repo.topics ?? [],
      summaryText,
      readmeText: null as string | null,
    }

    // 1) 确定性规则优先。
    let categories = classifyDeterministic(deterministicInput)

    // 2) 信息不足且无已有摘要时，才复用项目已有的 README 获取能力（best-effort）。
    let readmeFetched = false
    const thinInfo = !summaryText && !repo.description && (repo.topics ?? []).length === 0
    if (categories.length === 0 && thinInfo && process.env.CLASSIFICATION_FETCH_README !== "0") {
      try {
        const readme = await fetchRepoReadme(userId, repo.owner, repo.name)
        if (readme) {
          readmeFetched = true
          deterministicInput.readmeText = readme
          categories = classifyDeterministic(deterministicInput)
        }
      } catch {
        // README 拉取失败只是降级，不阻塞后续流程。
      }
    }

    // 3) 规则仍未命中时：有最低信号 → LLM 兜底；完全无信号 → unclassified 不硬猜。
    if (categories.length === 0) {
      const unclassify = async (error: string): Promise<ClassificationOutcome> => {
        await persistClassification({
          userId,
          repositoryId,
          contentHash: hash,
          status: "unclassified",
          categorySlugs: [],
          error,
        })
        // unclassified = 本次不再属于任何分类：清掉旧的 auto 关系（manual/excluded 仍受保护）。
        await syncAutoCollectionLinks(userId, repositoryId, [])
        return { status: "unclassified", categorySlugs: [], fromCache: false }
      }

      const hasSignal = hasSufficientCategorySignal({
        description: repo.description,
        topics: repo.topics ?? [],
        summaryText,
        readmeText: deterministicInput.readmeText,
      })
      if (!hasSignal) {
        return unclassify("Insufficient information to classify")
      }

      if (!process.env.OPENAI_API_KEY) {
        return unclassify("No AI fallback available (OPENAI_API_KEY not set)")
      }

      try {
        const llmResult = await classifyWithLLM({
          fullName: repo.fullName,
          description: repo.description,
          language: repo.language,
          topics: repo.topics ?? [],
          stars: repo.stars,
          summaryText,
          readmeText: deterministicInput.readmeText,
        })
        categories = llmResult.categories

        if (categories.length === 0) {
          return unclassify(
            llmResult.reason ? `LLM returned no categories: ${llmResult.reason}` : "LLM returned no valid categories"
          )
        }

        await persistClassification({
          userId,
          repositoryId,
          contentHash: hash,
          status: "classified",
          categorySlugs: categories,
        })
        await syncAutoCollectionLinks(userId, repositoryId, categories, llmResult.confidence, llmResult.reason)
        return {
          status: "classified",
          categorySlugs: categories,
          fromCache: false,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Classification LLM call failed"
        await persistClassification({
          userId,
          repositoryId,
          contentHash: hash,
          status: "failed",
          categorySlugs: [],
          error: message.slice(0, 1000),
        })
        return failedOutcome(message)
      }
    }

    // 4) 确定性规则命中 → 直接 classified（fromCache = 本条未走外部网络）。
    await persistClassification({
      userId,
      repositoryId,
      contentHash: hash,
      status: "classified",
      categorySlugs: categories,
    })
    await syncAutoCollectionLinks(userId, repositoryId, categories)
    return { status: "classified", categorySlugs: categories, fromCache: !readmeFetched }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown classification error"
    return failedOutcome(message.slice(0, 1000))
  }
}

// ── 批量分类 ────────────────────────────────────────────────────

function readConcurrency(): number {
  const raw = Number(process.env.CLASSIFICATION_CONCURRENCY)
  if (!Number.isFinite(raw)) return 2
  return Math.max(1, Math.min(8, Math.floor(raw)))
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++
        if (i >= items.length) return
        await fn(items[i])
      }
    }
  )
  await Promise.allSettled(workers)
}

export async function classifyRepositories(args: ClassifyRepositoriesArgs): Promise<ClassificationBatchResult> {
  const { userId, mode = "all", repositoryIds, force = false, onProgress } = args

  const repoWhere =
    repositoryIds && repositoryIds.length > 0
      ? { userId, id: { in: [...new Set(repositoryIds)] } }
      : { userId }
  const repos = await prisma.repository.findMany({
    where: repoWhere,
    select: { id: true },
  })
  const ids = repos.map((r) => r.id)

  let queue = ids
  if (mode === "unclassified") {
    const rows = await prisma.repositoryClassification.findMany({
      where: { userId },
      select: { repositoryId: true, status: true },
    })
    const classifiedIds = new Set(
      rows.filter((r) => r.status === "classified").map((r) => r.repositoryId)
    )
    queue = ids.filter((id) => !classifiedIds.has(id))
  }

  const total = queue.length
  let processed = 0
  let succeeded = 0
  let skipped = 0
  let failed = 0

  const emit = async (): Promise<void> => {
    if (onProgress) await onProgress({ total, processed, succeeded, skipped, failed })
  }
  await emit()

  const isForced = force || mode === "reclassify"
  await runPool(queue, readConcurrency(), async (repositoryId) => {
    const outcome = await classifyRepository({ userId, repositoryId, force: isForced })
    processed++
    if (outcome.status === "failed") failed++
    else if (outcome.status === "skipped") skipped++
    else succeeded++ // classified 或 unclassified 都算成功完成
    await emit()
  })

  return { total, succeeded, skipped, failed }
}