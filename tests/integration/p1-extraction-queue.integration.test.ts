import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// ── External data sources mocked; Prisma talks to the isolated fresh DB ──

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  embeddingCreate: vi.fn(),
  fetchRepoFileTree: vi.fn(),
  fetchFileContent: vi.fn(),
}))

vi.mock("@/lib/openai", () => ({
  openai: { chat: { completions: { create: mocks.openaiCreate } } },
}))
vi.mock("@/lib/embeddings", () => ({
  embeddingsOpenAI: { embeddings: { create: mocks.embeddingCreate } },
}))
vi.mock("@/services/github", () => ({
  fetchRepoFileTree: mocks.fetchRepoFileTree,
  fetchFileContent: mocks.fetchFileContent,
}))

import { prisma } from "@/lib/prisma"
import { enqueueAssetExtraction, REPOSITORY_NOT_FOUND_ERROR } from "@/services/intake"
import { extractFromFile, extractWithLLM, extractAssetsFromRepo } from "@/services/knowledge/extraction.service"
import { analyzeRepoSummary } from "@/services/llm/analysis.service"
import { syncRepoToDb, type GitHubRepo } from "@/services/github/repos.service"

const SUMMARY_JSON = JSON.stringify({
  oneLine: "A sample repo",
  problem: "Solves duplication",
  techStack: ["TypeScript"],
  scenarios: ["Learning"],
  highlights: ["Clean"],
  learningValue: "Patterns",
  reuseSuggestion: "Reuse the layout",
  simpleExplanation: "A small demo.",
})

const SORTING_CONTENT =
  "function quickSort(list) {\n  if (list.length <= 1) return list;\n  const pivot = list[0];\n  const rest = list.slice(1);\n  return [...quickSort(rest.filter((x) => x < pivot)), pivot, ...quickSort(rest.filter((x) => x >= pivot))];\n}"

function vector(index: number): number[] {
  const values = Array<number>(1536).fill(0)
  values[index] = 1
  return values
}

const savedKey = process.env.OPENAI_API_KEY

beforeAll(async () => {
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(databaseName)) {
    throw new Error("Extraction tests refuse to run outside an isolated fresh test database")
  }

  const now = new Date()
  await prisma.user.create({ data: { id: "p1x-user", name: "P1 User", updatedAt: now } })
  await prisma.repository.createMany({
    data: [
      {
        id: "p1x-repo-1", githubId: 8101, owner: "alice", name: "p1-extraction",
        fullName: "alice/p1-extraction", description: "Helper repo for extraction",
        url: "https://example.invalid/p1x/1", language: "TypeScript", stars: 5,
        topics: ["demo"], userId: "p1x-user", updatedAt: now,
      },
      {
        id: "p1x-repo-2", githubId: 8102, owner: "alice", name: "p1-summary",
        fullName: "alice/p1-summary", description: "Repo summary caching",
        url: "https://example.invalid/p1x/2", language: "Go", stars: 8,
        topics: ["sample"], userId: "p1x-user", updatedAt: now,
      },
    ],
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.embeddingCreate.mockResolvedValue({ data: [{ embedding: vector(0) }] })
  mocks.openaiCreate.mockResolvedValue({ choices: [{ message: { content: SUMMARY_JSON } }] })
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-not-real"
})

afterAll(async () => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = savedKey
  await prisma.$disconnect()
})

describe("intake queue behaviour against the real database", () => {
  it("queues an asset extraction once and deduplicates while in flight", async () => {
    const first = await enqueueAssetExtraction("p1x-repo-1", "p1x-user")
    expect(first.status).toBe("queued")

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id: first.analysisId } })
    expect(row.analysisType).toBe("asset_extraction")
    expect(row.status).toBe("pending")
    expect((row.input as Record<string, unknown>).useLLM).toBe(true)
    expect((row.input as Record<string, unknown>).maxFiles).toBe(20)

    const second = await enqueueAssetExtraction("p1x-repo-1", "p1x-user")
    expect(second.status).toBe("already_queued")
  })

  it("refuses to enqueue asset extraction against a repository owned by another user", async () => {
    // A second user must not be able to queue work against p1x-repo-1, which the
    // p1x-user owns (P1 cross-user isolation regression).
    await prisma.user.create({
      data: { id: "p1x-intruder", name: "Intruder", updatedAt: new Date() },
    })

    const result = await enqueueAssetExtraction("p1x-repo-1", "p1x-intruder")

    expect(result.status).toBe("error")
    expect(result.error).toBe(REPOSITORY_NOT_FOUND_ERROR)
    const rows = await prisma.analysis.findMany({
      where: { repositoryId: "p1x-repo-1", userId: "p1x-intruder" },
    })
    expect(rows).toHaveLength(0)
  })

  it("collapses concurrent enqueues to a single pending row (requires the active partial unique index)", async () => {
    const results = await Promise.all([
      enqueueAssetExtraction("p1x-repo-2", "p1x-user"),
      enqueueAssetExtraction("p1x-repo-2", "p1x-user"),
    ])

    const queued = results.filter((r) => r.status === "queued")
    const dups = results.filter((r) => r.status === "already_queued")
    expect(queued.length + dups.length).toBe(2)
    expect(queued.length).toBe(1)

    const active = await prisma.analysis.findMany({
      where: {
        repositoryId: "p1x-repo-2",
        userId: "p1x-user",
        analysisType: "asset_extraction",
        status: { in: ["pending", "running"] },
      },
    })
    expect(active).toHaveLength(1)
  })
})

describe("per-user repository identity against the real database", () => {
  it("syncs the same GitHub repository into independent rows for two users", async () => {
    const userIds = ["p1x-sync-a", "p1x-sync-b"] as const
    const now = new Date()
    await prisma.user.createMany({
      data: userIds.map((id) => ({ id, name: `Sync ${id}`, updatedAt: now })),
    })

    const githubRepo: GitHubRepo = {
      id: 848401,
      owner: "shared-owner",
      name: "shared-repo",
      fullName: "shared-owner/shared-repo",
      description: "Synced independently by two users",
      url: "https://example.invalid/shared-owner/shared-repo",
      homepage: null,
      language: "TypeScript",
      stars: 7,
      forks: 1,
      topics: ["isolation"],
      defaultBranch: "main",
      isArchived: false,
      isTemplate: false,
      license: "MIT",
      size: 20,
      pushedAt: null,
    }

    await syncRepoToDb(userIds[0], githubRepo)
    await syncRepoToDb(userIds[1], githubRepo)

    const where = { githubId: githubRepo.id, userId: { in: [...userIds] } }
    const initial = await prisma.repository.findMany({ where })
    expect(initial).toHaveLength(2)
    expect(new Set(initial.map((repo) => repo.id)).size).toBe(2)
    expect(initial.map((repo) => repo.userId).sort()).toEqual([...userIds])
    expect(initial.every((repo) => repo.fullName === githubRepo.fullName)).toBe(true)

    // Re-syncing A updates only A's row; it neither steals nor duplicates B's.
    await syncRepoToDb(userIds[0], { ...githubRepo, stars: 99 })
    const after = await prisma.repository.findMany({ where })
    expect(after).toHaveLength(2)
    expect(after.find((repo) => repo.userId === userIds[0])?.stars).toBe(99)
    expect(after.find((repo) => repo.userId === userIds[1])?.stars).toBe(7)
  })
})

describe("knowledge asset extraction pipeline against the real database", () => {
  const tree = [
    { path: "src/helper.ts", type: "file" as const, size: 200 },
    { path: "docs/guide.md", type: "file" as const, size: 1000 },
  ]

  beforeEach(() => {
    mocks.fetchRepoFileTree.mockResolvedValue(tree)
    mocks.fetchFileContent.mockResolvedValue(SORTING_CONTENT)
  })

  it("persists KnowledgeAsset and Embedding rows, then skips them on rerun", async () => {
    const result = await extractAssetsFromRepo("p1x-user", "p1x-repo-1", "alice", "p1-extraction", {
      maxFiles: 5,
      useLLM: false,
    })

    expect(result).toEqual({ extracted: 2, skipped: 0, embedded: 2 })

    const assets = await prisma.knowledgeAsset.findMany({
      where: { repositoryId: "p1x-repo-1" },
      select: { sourcePath: true, language: true },
    })
    expect(assets.map((a) => a.sourcePath)).toEqual(
      expect.arrayContaining(["src/helper.ts", "docs/guide.md"]),
    )
    expect(assets.every((a) => a.language != null)).toBe(true)

    const embeddings = await prisma.$queryRawUnsafe<Array<{ assetId: string }>>(
      `SELECT e."assetId"
       FROM "Embedding" e
       JOIN "KnowledgeAsset" ka ON ka."id" = e."assetId"
       WHERE ka."repositoryId" = $1`,
      "p1x-repo-1",
    )
    expect(embeddings).toHaveLength(2)

    // Rerun: existing paths are deduplicated up-front before any create is attempted
    const rerun = await extractAssetsFromRepo("p1x-user", "p1x-repo-1", "alice", "p1-extraction", {
      maxFiles: 5,
      useLLM: false,
    })
    expect(rerun).toEqual({ extracted: 0, skipped: 2, embedded: 0 })
  })

  it("persists a validated difficulty parsed from the LLM result and keeps null for unparseable payloads", async () => {
    const patternJson = JSON.stringify({
      patternName: "DispatchPipeline",
      whatItDoes: "Event-driven middleware dispatch",
      reuseValue: "Reuse the pipeline",
      keyInsight: "Decouple handlers",
      difficulty: "advanced",
    })
    mocks.openaiCreate.mockResolvedValue({ choices: [{ message: { content: patternJson } }] })

    const rich =
      "// event-driven middleware pipeline with a retry queue and dead-letter architecture\n" +
      "// reliable job delivery across workers with graceful fallbacks and caching\n"
    const content = rich.repeat(3).padEnd(120, "x")

    const result = await extractWithLLM("p1x-user", "p1x-repo-1", "src/dispatch-llm.ts", content, "TypeScript")
    expect(result).not.toBeNull()

    const asset = await prisma.knowledgeAsset.findUniqueOrThrow({ where: { id: result!.assetId } })
    expect(asset.difficulty).toBe("advanced")
    expect(asset.summary).toBe(patternJson)

    // Invalid difficulty must be stored as null, never fabricated.
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ patternName: "X", whatItDoes: "y", difficulty: "expert" }) } }],
    })
    const fallback = await extractWithLLM("p1x-user", "p1x-repo-1", "src/dispatch-bad.ts", content, "TypeScript")
    const badAsset = await prisma.knowledgeAsset.findUniqueOrThrow({ where: { id: fallback!.assetId } })
    expect(badAsset.difficulty).toBeNull()
  })

  it("refuses to extract assets into a repository the caller does not own", async () => {
    await expect(
      extractAssetsFromRepo("someone-else", "p1x-repo-2", "alice", "p1-summary", { maxFiles: 1, useLLM: false }),
    ).rejects.toThrow("Repository not found or not owned by this user")
  })

  it("keeps extractFromFile assets explicit with a null difficulty", async () => {
    const result = await extractFromFile("p1x-user", "p1x-repo-1", "src/plain-helper.ts", "const a = 1\n".repeat(20), "TypeScript")
    expect(result).not.toBeNull()
    const asset = await prisma.knowledgeAsset.findUniqueOrThrow({ where: { id: result!.assetId } })
    expect(asset.difficulty).toBeNull()
  })
})

describe("LLM repo summary against the real database", () => {
  const repoMeta = {
    name: "p1-summary",
    fullName: "alice/p1-summary",
    description: "Repo summary caching",
    language: "Go",
    topics: ["sample"],
    stars: 8,
    forks: 1,
    url: "https://example.invalid/p1x/2",
    defaultBranch: "main",
  }

  it("persists the completed summary and serves the second call from cache", async () => {
    const first = await analyzeRepoSummary("p1x-repo-2", "p1x-user", repoMeta, "# Readme")

    expect(first.cached).toBe(false)
    expect(first.summary.oneLine).toBe("A sample repo")

    const stored = await prisma.analysis.findFirst({
      where: {
        repositoryId: "p1x-repo-2",
        userId: "p1x-user",
        analysisType: "repo_summary",
        status: "completed",
      },
    })
    expect(stored).not.toBeNull()
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()

    // Cache hits should not call the LLM again
    const second = await analyzeRepoSummary("p1x-repo-2", "p1x-user", repoMeta, "# Readme")
    expect(second.cached).toBe(true)
    expect(second.summary).toEqual(first.summary)
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
  })
})