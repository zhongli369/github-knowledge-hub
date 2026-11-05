import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"

// ── 编排层测试：classifyRepository / classifyRepositories / 集合补齐 / 自动关系 ──
// prisma 与 GitHub 全部 mock，绝不触碰真实数据库或网络/付费 LLM。

import { computeRepoContentHash } from "@/lib/classification/fingerprint"
import { REPO_CATEGORY_DEFINITIONS } from "@/lib/classification/taxonomy"

const mocks = vi.hoisted(() => ({
  repoFindFirst: vi.fn(),
  repoFindMany: vi.fn(),
  analysisFindFirst: vi.fn(),
  classFindUnique: vi.fn(),
  classFindMany: vi.fn(),
  classUpsert: vi.fn(),
  colFindMany: vi.fn(),
  colCreateMany: vi.fn(),
  linkFindMany: vi.fn(),
  linkUpdate: vi.fn(),
  linkDelete: vi.fn(),
  linkCreate: vi.fn(),
  fetchRepoReadme: vi.fn(),
  openaiCreate: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: {
      findFirst: mocks.repoFindFirst,
      findMany: mocks.repoFindMany,
    },
    analysis: { findFirst: mocks.analysisFindFirst },
    repositoryClassification: {
      findUnique: mocks.classFindUnique,
      findMany: mocks.classFindMany,
      upsert: mocks.classUpsert,
    },
    collection: {
      findMany: mocks.colFindMany,
      createMany: mocks.colCreateMany,
    },
    collectionRepository: {
      findMany: mocks.linkFindMany,
      updateMany: mocks.linkUpdate,
      deleteMany: mocks.linkDelete,
      create: mocks.linkCreate,
    },
  },
}))
vi.mock("@/services/github", () => ({ fetchRepoReadme: mocks.fetchRepoReadme }))
vi.mock("@/lib/openai", () => ({
  openai: { chat: { completions: { create: mocks.openaiCreate } } },
}))

import {
  classifyRepository,
  classifyRepositories,
  ensureCategoryCollections,
  syncAutoCollectionLinks,
} from "@/lib/classification/service"

const ALL_CATS = REPO_CATEGORY_DEFINITIONS.map((d) => ({
  id: `col-${d.slug}`,
  slug: d.slug,
}))

const savedKey = process.env.OPENAI_API_KEY
const savedDelay = process.env.LLM_RETRY_BASE_DELAY_MS
const savedConcurrency = process.env.CLASSIFICATION_CONCURRENCY

interface RepoRow {
  id: string
  name: string
  fullName: string
  description: string | null
  language: string | null
  homepage: string | null
  topics: string[]
  stars: number
  owner: string
}

function repoMeta(
  id: string,
  over: Partial<Omit<RepoRow, "id">> = {}
): RepoRow {
  return {
    id,
    name: `r-${id}`,
    fullName: `u/r-${id}`,
    description: null,
    language: "TypeScript",
    homepage: null,
    topics: [],
    stars: 0,
    owner: "u",
    ...over,
  }
}

function repoHash(row: RepoRow): string {
  return computeRepoContentHash({ ...row, summaryText: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENAI_API_KEY = "sk-test-not-real"
  process.env.LLM_RETRY_BASE_DELAY_MS = "0"
  process.env.CLASSIFICATION_CONCURRENCY = "1"

  mocks.repoFindMany.mockResolvedValue([])
  mocks.analysisFindFirst.mockResolvedValue(null)
  mocks.classFindUnique.mockResolvedValue(null)
  mocks.classFindMany.mockResolvedValue([])
  mocks.classUpsert.mockResolvedValue({})
  mocks.colFindMany.mockResolvedValue(ALL_CATS)
  mocks.colCreateMany.mockResolvedValue({ count: 0 })
  mocks.linkFindMany.mockResolvedValue([])
  mocks.linkUpdate.mockResolvedValue({})
  mocks.linkDelete.mockResolvedValue({})
  mocks.linkCreate.mockResolvedValue({})
  mocks.fetchRepoReadme.mockResolvedValue(null)
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = savedKey
  if (savedDelay === undefined) delete process.env.LLM_RETRY_BASE_DELAY_MS
  else process.env.LLM_RETRY_BASE_DELAY_MS = savedDelay
  if (savedConcurrency === undefined) delete process.env.CLASSIFICATION_CONCURRENCY
  else process.env.CLASSIFICATION_CONCURRENCY = savedConcurrency
})

describe("ensureCategoryCollections", () => {
  it("creates only the missing category collections and keeps existing", async () => {
    mocks.colFindMany.mockResolvedValue([{ slug: "ai-llm-agent" }])
    await ensureCategoryCollections("user-1")
    expect(mocks.colCreateMany).toHaveBeenCalledTimes(1)
    const data = mocks.colCreateMany.mock.calls[0][0].data as Array<Record<string, unknown>>
    expect(data).toHaveLength(REPO_CATEGORY_DEFINITIONS.length - 1)
    expect(data[0]).toMatchObject({ userId: "user-1", kind: "category", isPublic: false })
    expect(data.every((d) => typeof d.slug === "string" && typeof d.name === "string")).toBe(true)
    expect(data.some((d) => d.slug === "ai-llm-agent")).toBe(false)
  })

  it("does not create when everything already exists", async () => {
    await ensureCategoryCollections("user-1")
    expect(mocks.colCreateMany).not.toHaveBeenCalled()
  })
})

describe("syncAutoCollectionLinks — manual/excluded protection", () => {
  it("updates auto targets, deletes dropped auto links, never touches manual/excluded", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { id: "l1", collectionId: "col-ai-llm-agent", source: "auto", excluded: false },
      { id: "l2", collectionId: "col-learning", source: "manual", excluded: false },
      { id: "l3", collectionId: "col-devops", source: "auto", excluded: true },
      { id: "l4", collectionId: "col-security-privacy", source: "auto", excluded: false },
    ])

    await syncAutoCollectionLinks("user-1", "repo-1", ["ai-llm-agent", "learning"], 0.9, "rule match")

    expect(mocks.linkUpdate).toHaveBeenCalledWith({
      where: { id: "l1", source: "auto", excluded: false },
      data: { confidence: 0.9, reason: "rule match" },
    })
    expect(mocks.linkDelete).toHaveBeenCalledWith({
      where: { id: "l4", source: "auto", excluded: false },
    })
    // manual / excluded 行永不被更新或删除
    expect(mocks.linkUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "l2" } })
    )
    expect(mocks.linkUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "l3" } })
    )
    expect(mocks.linkDelete).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "l2" } })
    )
    expect(mocks.linkDelete).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "l3" } })
    )
    // col-learning 是目标但被 manual 占据 → 不新增
    expect(mocks.linkCreate).not.toHaveBeenCalled()
  })

  it("creates new auto links for target collections without any existing link", async () => {
    mocks.linkFindMany.mockResolvedValue([])
    await syncAutoCollectionLinks("user-1", "repo-9", ["frontend-ui"])
    expect(mocks.linkCreate).toHaveBeenCalledTimes(1)
    expect(mocks.linkCreate).toHaveBeenCalledWith({
      data: { collectionId: "col-frontend-ui", repositoryId: "repo-9", source: "auto", confidence: null, reason: null },
    })
  })
})

describe("classifyRepository", () => {
  it("skips without AI when already classified and hash/version unchanged", async () => {
    const meta = repoMeta("r1", { description: "A demo", topics: ["demo"] })
    mocks.repoFindFirst.mockResolvedValue(meta)
    const hash = repoHash(meta)
    mocks.classFindUnique.mockResolvedValue({
      repositoryId: "r1",
      userId: "user-1",
      status: "classified",
      contentHash: hash,
      classifierVersion: "1.0.0",
      categorySlugs: ["learning"],
    })

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r1" })

    expect(outcome).toMatchObject({ status: "skipped", categorySlugs: ["learning"], fromCache: true })
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
    expect(mocks.classUpsert).not.toHaveBeenCalled()
    expect(mocks.linkFindMany).not.toHaveBeenCalled()
  })

  it("ignores the cache when force=true and reclassifies", async () => {
    const meta = repoMeta("r1", { description: "A demo", topics: ["demo"] })
    mocks.repoFindFirst.mockResolvedValue(meta)
    const hash = repoHash(meta)
    mocks.classFindUnique.mockResolvedValue({
      repositoryId: "r1",
      userId: "user-1",
      status: "classified",
      contentHash: hash,
      classifierVersion: "1.0.0",
      categorySlugs: ["learning"],
    })

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r1", force: true })

    expect(outcome.status).toBe("classified")
    expect(mocks.classUpsert).toHaveBeenCalled()
  })

  it("classifies deterministically from metadata and persists auto links", async () => {
    mocks.repoFindFirst.mockResolvedValue(
      repoMeta("r2", { description: "A web scraper for news sites", topics: ["crawler"] })
    )

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r2" })

    expect(outcome).toMatchObject({
      status: "classified",
      categorySlugs: ["crawler-scraping"],
      fromCache: true,
    })
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
    expect(mocks.classUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          repositoryId: "r2",
          userId: "user-1",
          status: "classified",
          categorySlugs: ["crawler-scraping"],
        }),
      })
    )
    expect(mocks.linkCreate).toHaveBeenCalledWith({
      data: {
        collectionId: "col-crawler-scraping",
        repositoryId: "r2",
        source: "auto",
        confidence: null,
        reason: null,
      },
    })
  })

  it("supports multi-classification from an existing AI repo_summary without re-summarizing", async () => {
    mocks.repoFindFirst.mockResolvedValue(
      repoMeta("r3", { description: "AI crawler with an automation pipeline", topics: [] })
    )
    mocks.analysisFindFirst.mockResolvedValue({
      result: {
        summary: {
          oneLine: "Automated AI crawler",
          problem: "Collects training data",
          techStack: ["Python"],
          scenarios: ["NLP"],
          highlights: ["Fast"],
          learningValue: "Scraping",
          reuseSuggestion: "Reuse",
          simpleExplanation: "A crawler.",
        },
      },
    })

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r3" })

    expect(outcome.status).toBe("classified")
    const slugs = outcome.categorySlugs
    expect(slugs).toContain("crawler-scraping")
    expect(slugs).toContain("ai-llm-agent")
    expect(slugs).toContain("automation-workflow")
    // 复用已有摘要：不走 GitHub README，也不调用 LLM
    expect(mocks.fetchRepoReadme).not.toHaveBeenCalled()
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
  })

  it("uses LLM fallback when rules miss but signal exists", async () => {
    mocks.repoFindFirst.mockResolvedValue(
      repoMeta("r4", { description: "Daily-use helper utilities", topics: [] })
    )
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"categorySlugs":["devtools-cli","learning"]}' } }],
      usage: { total_tokens: 40 },
    })

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r4" })

    expect(outcome).toMatchObject({ status: "classified", categorySlugs: ["devtools-cli", "learning"], fromCache: false })
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(1)
  })

  it("marks unclassified on genuinely insufficient info without calling LLM (no hard guessing)", async () => {
    mocks.repoFindFirst.mockResolvedValue(
      repoMeta("r5", { description: null, topics: [], language: "Python" })
    )
    mocks.fetchRepoReadme.mockResolvedValue(null)

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r5" })

    expect(outcome).toMatchObject({ status: "unclassified", categorySlugs: [], fromCache: false })
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
    expect(mocks.classUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "unclassified", categorySlugs: [] }),
      })
    )
    // unclassified 会清掉旧 auto 关系（本次无目标集合 → 只读检查，不新增）
    expect(mocks.linkFindMany).toHaveBeenCalledTimes(1)
    expect(mocks.linkCreate).not.toHaveBeenCalled()
  })

  it("uses README as an additional source before giving up (reuses existing fetch capability)", async () => {
    mocks.repoFindFirst.mockResolvedValue(
      repoMeta("r6", { description: null, topics: [], language: "Rust" })
    )
    mocks.fetchRepoReadme.mockResolvedValue("# Web scraping toolkit\ncrawler and parser")

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r6" })

    expect(outcome.status).toBe("classified")
    expect(outcome.categorySlugs).toContain("crawler-scraping")
    expect(outcome.fromCache).toBe(false)
    expect(mocks.fetchRepoReadme).toHaveBeenCalledWith("user-1", "u", "r-r6")
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
  })

  it("returns failed (not throw) for a repository not owned by the user", async () => {
    mocks.repoFindFirst.mockResolvedValue(null)
    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "foreign" })
    expect(outcome.status).toBe("failed")
  })

  it("refuses to reuse a classification row owned by another user", async () => {
    mocks.repoFindFirst.mockResolvedValue(repoMeta("r1", { description: "A demo" }))
    mocks.classFindUnique.mockResolvedValue({
      repositoryId: "r1",
      userId: "user-2",
      status: "classified",
      contentHash: "x",
      classifierVersion: "1.0.0",
      categorySlugs: [],
    })
    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r1" })
    expect(outcome.status).toBe("failed")
  })

  it("returns failed when the LLM call fails and persists the failure", async () => {
    mocks.repoFindFirst.mockResolvedValue(
      repoMeta("r7", { description: "Something generic about tooling", topics: [] })
    )
    mocks.openaiCreate.mockRejectedValue(new Error("Incorrect API key provided"))

    const outcome = await classifyRepository({ userId: "user-1", repositoryId: "r7" })

    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("API key")
    expect(mocks.classUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "failed", categorySlugs: [] }),
      })
    )
  })
})

describe("classifyRepositories", () => {
  it("counts skipped/classified/failed and reports progress", async () => {
    const r1 = repoMeta("r1", { description: "A demo", topics: [] })
    const r2 = repoMeta("r2", { description: "Vector database for AI apps", topics: ["database"] })
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }])
    mocks.repoFindFirst.mockImplementation(async (args: { where: { id?: string } }) => {
      const id = args.where.id
      if (id === "r1") return r1
      if (id === "r2") return r2
      return null // r3 不属于该用户
    })
    const r1Hash = repoHash(r1)
    mocks.classFindUnique.mockImplementation(async (args: { where: { repositoryId?: string } }) => {
      if (args.where.repositoryId === "r1") {
        return {
          repositoryId: "r1",
          userId: "user-1",
          status: "classified",
          contentHash: r1Hash,
          classifierVersion: "1.0.0",
          categorySlugs: ["learning"],
        }
      }
      return null
    })

    const progress: Array<Record<string, number>> = []
    const result = await classifyRepositories({
      userId: "user-1",
      mode: "all",
      onProgress: (p) => void progress.push({ ...p }),
    })

    expect(result).toEqual({ total: 3, succeeded: 1, skipped: 1, failed: 1 })
    expect(progress).toHaveLength(4) // 初始 + 每个仓库后
    const last = progress[progress.length - 1]
    expect(last).toMatchObject({ total: 3, processed: 3, succeeded: 1, skipped: 1, failed: 1 })
  })

  it("mode=unclassified only processes repos without a successful classification", async () => {
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }])
    mocks.classFindMany.mockResolvedValue([
      { repositoryId: "r1", status: "classified" },
      { repositoryId: "r2", status: "unclassified" },
    ])
    mocks.repoFindFirst.mockImplementation(async (args: { where: { id?: string } }) => {
      const id = args.where.id
      if (id === "r2") return repoMeta("r2", { description: "A web scraper", topics: ["crawler"] })
      if (id === "r3") return repoMeta("r3", { description: "Kubernetes infrastructure", topics: ["devops"] })
      return null
    })

    const result = await classifyRepositories({ userId: "user-1", mode: "unclassified" })

    expect(result.total).toBe(2)
    // r1（classified）不该被处理
    expect(mocks.repoFindFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" } })
    )
    expect(result).toMatchObject({ succeeded: 2, failed: 0 })
  })

  it("honors repositoryIds subset and never processes other users' repos", async () => {
    mocks.repoFindMany.mockResolvedValue([{ id: "r2" }]) // r9 越权被 where 过滤掉
    mocks.repoFindFirst.mockResolvedValue(repoMeta("r2", { description: "A scraper", topics: ["crawler"] }))

    const result = await classifyRepositories({
      userId: "user-1",
      repositoryIds: ["r2", "r9"],
    })

    expect(result.total).toBe(1)
    expect(result).toMatchObject({ succeeded: 1, failed: 0 })
  })
})