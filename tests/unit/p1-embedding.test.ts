import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Embedding API + Prisma fully mocked; no real network or DB access ──

const mocks = vi.hoisted(() => ({
  embeddingCreate: vi.fn(),
  executeRawUnsafe: vi.fn(),
  queryRawUnsafe: vi.fn(),
  repoFindFirst: vi.fn(),
  repoFindMany: vi.fn(),
  analysisFindFirst: vi.fn(),
  analysisFindMany: vi.fn(),
  embeddingFindUnique: vi.fn(),
  repoEmbeddingFindUnique: vi.fn(),
  repoEmbeddingFindMany: vi.fn(),
}))

vi.mock("@/lib/embeddings", () => ({
  embeddingsOpenAI: { embeddings: { create: mocks.embeddingCreate } },
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRawUnsafe: mocks.executeRawUnsafe,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    repository: { findFirst: mocks.repoFindFirst, findMany: mocks.repoFindMany },
    analysis: { findFirst: mocks.analysisFindFirst, findMany: mocks.analysisFindMany },
    embedding: { findUnique: mocks.embeddingFindUnique },
    repoEmbedding: { findUnique: mocks.repoEmbeddingFindUnique, findMany: mocks.repoEmbeddingFindMany },
  },
}))

import {
  generateEmbedding,
  embedKnowledgeAsset,
  searchSimilarAssets,
  searchByText,
  getSimilarAssets,
  searchAssetsPage,
} from "@/services/llm/embeddings.service"
import {
  generateRepoEmbedding,
  checkEmbeddingFreshness,
  searchReposByText,
  searchReposPage,
} from "@/services/llm/repo-embedding.service"

const smallVector = [0.1, 0.2]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.embeddingCreate.mockResolvedValue({ data: [{ embedding: smallVector }] })
  mocks.executeRawUnsafe.mockResolvedValue([])
  mocks.queryRawUnsafe.mockResolvedValue([])
})

describe("embedding generation", () => {
  it("calls the embeddings API with the model, sliced input and dimensions", async () => {
    const embedding = await generateEmbedding("hello world")

    expect(embedding).toEqual(smallVector)
    expect(mocks.embeddingCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: "hello world",
      dimensions: 1536,
    })
  })

  it("caps the input to 8191 characters", async () => {
    const long = "x".repeat(10000)
    await generateEmbedding(long)

    expect(mocks.embeddingCreate).toHaveBeenCalledWith(
      expect.objectContaining({ input: "x".repeat(8191) }),
    )
  })
})

describe("embedKnowledgeAsset", () => {
  it("upserts an Embedding row via raw SQL with a deterministic vector literal", async () => {
    await embedKnowledgeAsset("asset-1", "some content")

    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1)
    const [sql, id, assetId, vectorStr, model] = mocks.executeRawUnsafe.mock.calls[0] as [
      string,
      string,
      string,
      string,
      string,
    ]
    expect(sql).toContain('INSERT INTO "Embedding"')
    expect(sql).toContain('ON CONFLICT ("assetId") DO UPDATE')
    expect(id).toBeTypeOf("string")
    expect(assetId).toBe("asset-1")
    expect(vectorStr).toBe("[0.1,0.2]")
    expect(model).toBe("text-embedding-3-small")
  })

  it("propagates embedding API failures (callers treat embedding as best-effort)", async () => {
    mocks.embeddingCreate.mockRejectedValue(new Error("quota exceeded"))
    await expect(embedKnowledgeAsset("asset-1", "text")).rejects.toThrow("quota exceeded")
  })
})

describe("searchSimilarAssets", () => {
  it("builds positional filter conditions and threshold/limit into the raw SQL", async () => {
    const rows = [{ assetId: "a1", similarity: 0.95 }]
    mocks.queryRawUnsafe.mockResolvedValue(rows)

    const result = await searchSimilarAssets(smallVector, "user-1", 5, {
      assetType: "algorithm",
      language: "TypeScript",
      difficulty: "intermediate",
      tags: ["x", "y"],
    })

    expect(result).toEqual(rows)
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1)
    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ]
    expect(sql).toContain('ka."assetType" = $3')
    expect(sql).toContain('ka."language" = $4')
    expect(sql).toContain('ka."difficulty" = $5')
    expect(sql).toContain('ka."tags" @> $6::text[]')
    expect(sql).toContain("1 - (e.\"vector\" <=> $1::vector) > $7")
    expect(sql).toContain("LIMIT $8")
    expect(params).toEqual([
      "[0.1,0.2]",
      "user-1",
      "algorithm",
      "TypeScript",
      "intermediate",
      ["x", "y"],
      0.3,
      5,
    ])
  })

  it("keeps the default threshold and limit when no filters are supplied", async () => {
    await searchSimilarAssets(smallVector, "user-1")
    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ]
    // No filter placeholders: threshold lands at $3 and limit at $4
    expect(sql).toContain("1 - (e.\"vector\" <=> $1::vector) > $3")
    expect(sql).toContain("LIMIT $4")
    expect(params).toEqual(["[0.1,0.2]", "user-1", 0.3, 10])
  })

  it("searchByText embeds the query before running the semantic query", async () => {
    const rows = [{ assetId: "a1", similarity: 0.9 }]
    mocks.queryRawUnsafe.mockResolvedValue(rows)

    const result = await searchByText("quick sort algorithm", "user-1")

    expect(mocks.embeddingCreate).toHaveBeenCalledOnce()
    expect(result).toEqual(rows)
    expect(mocks.queryRawUnsafe).toHaveBeenCalledOnce()
  })
})

describe("getSimilarAssets", () => {
  it("returns an empty list when the source asset has no embedding", async () => {
    mocks.embeddingFindUnique.mockResolvedValue(null)

    expect(await getSimilarAssets("asset-missing", "user-1")).toEqual([])
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled()
  })

  it("queries sibling embeddings and excludes the source asset itself", async () => {
    mocks.embeddingFindUnique.mockResolvedValue({ assetId: "asset-target" })
    mocks.queryRawUnsafe.mockResolvedValue([{ assetId: "asset-other" }])

    const result = await getSimilarAssets("asset-target", "user-1", 5)

    expect(result).toEqual([{ assetId: "asset-other" }])
    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ]
    expect(sql).toContain('JOIN "Embedding" target ON target."assetId" = $1')
    expect(sql).toContain('ka."id" != $1')
    expect(sql).toContain("LIMIT $3")
    expect(params).toEqual(["asset-target", "user-1", 5])
  })
})

describe("generateRepoEmbedding", () => {
  it("skips generation when the repository is not found", async () => {
    mocks.repoFindFirst.mockResolvedValue(null)

    expect(await generateRepoEmbedding("repo-1", "user-1")).toBe(false)
    expect(mocks.embeddingCreate).not.toHaveBeenCalled()
    expect(mocks.executeRawUnsafe).not.toHaveBeenCalled()
  })

  it("builds source text from repo metadata and the completed summary, then upserts with a text hash", async () => {
    mocks.repoFindFirst.mockResolvedValue({
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: "A demo",
      language: "TypeScript",
      topics: ["api"],
    })
    mocks.analysisFindFirst.mockResolvedValue({
      result: {
        summary: {
          oneLine: "one",
          problem: "problem",
          simpleExplanation: "explain",
          reuseSuggestion: "reuse",
        },
      },
    })

    const ok = await generateRepoEmbedding("repo-1", "user-1")

    expect(ok).toBe(true)
    expect(mocks.embeddingCreate).toHaveBeenCalledTimes(1)
    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1)
    const [sql, id, repoId, vectorStr, model, textHash] = mocks.executeRawUnsafe.mock
      .calls[0] as unknown as [string, string, string, string, string, string]
    expect(sql).toContain('INSERT INTO "RepoEmbedding"')
    expect(sql).toContain('ON CONFLICT ("repositoryId") DO UPDATE')
    expect(id).toBeTypeOf("string")
    expect(repoId).toBe("repo-1")
    expect(vectorStr).toBe("[0.1,0.2]")
    expect(model).toBe("text-embedding-3-small")
    expect(textHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("still embeds identity-only metadata when no completed summary exists", async () => {
    mocks.repoFindFirst.mockResolvedValue({
      name: "bare",
      fullName: "o/bare",
      description: null,
      language: null,
      topics: [],
    })
    mocks.analysisFindFirst.mockResolvedValue(null)

    expect(await generateRepoEmbedding("repo-1", "user-1")).toBe(true)
    expect(mocks.embeddingCreate).toHaveBeenCalledTimes(1)
    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1)
  })
})

describe("checkEmbeddingFreshness", () => {
  it("reports no embedding without stale state", async () => {
    mocks.repoEmbeddingFindUnique.mockResolvedValue(null)
    mocks.analysisFindFirst.mockResolvedValue(null)

    expect(await checkEmbeddingFreshness("repo-1", "user-1")).toEqual({
      hasEmbedding: false,
      isStale: false,
      embeddedAt: null,
      lastSummaryAt: null,
    })
  })

  it("flags an embedding as stale when the summary is newer than the embedding", async () => {
    mocks.repoEmbeddingFindUnique.mockResolvedValue({
      textHash: "some-old-hash",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    mocks.analysisFindFirst.mockResolvedValue({
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    })
    mocks.repoFindFirst.mockResolvedValue({
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: null,
      language: null,
      topics: [],
    })

    const freshness = await checkEmbeddingFreshness("repo-1", "user-1")

    expect(freshness.hasEmbedding).toBe(true)
    expect(freshness.isStale).toBe(true)
    expect(freshness.embeddedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(freshness.lastSummaryAt).toBe("2026-02-01T00:00:00.000Z")
  })
})

describe("searchReposByText boundary guards", () => {
  it("returns empty results for empty query, empty user and invalid limits without API or DB calls", async () => {
    for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      expect(await searchReposByText("  ", "user-1", 20, undefined, mode)).toEqual([])
      expect(await searchReposByText("hello", "", 20, undefined, mode)).toEqual([])
      expect(await searchReposByText("hello", "user-1", 0, undefined, mode)).toEqual([])
      expect(await searchReposByText("hello", "user-1", Number.NaN, undefined, mode)).toEqual([])
      expect(await searchReposByText("hello", "user-1", -5, undefined, mode)).toEqual([])
    }
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled()
    expect(mocks.embeddingCreate).not.toHaveBeenCalled()
  })

  it("keyword mode issues full-text SQL without an embedding API call", async () => {
    mocks.queryRawUnsafe.mockResolvedValue([{ repoId: "r1", similarity: 0.5 }])

    const results = await searchReposByText("postgresql search", "user-1", 20, undefined, "keyword")

    expect(results).toEqual([{ repoId: "r1", similarity: 0.5 }])
    expect(mocks.embeddingCreate).not.toHaveBeenCalled()
    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ]
    expect(sql).toContain("websearch_to_tsquery('english', $1)")
    expect(sql).toContain('r."userId" = $2')
    expect(sql).toContain("LIMIT $3")
    expect(sql).toContain('COALESCE(ts_rank(r."searchVector"')
    expect(params).toEqual(["postgresql search", "user-1", 20])
  })

  it("hybrid mode fuses vector and full-text scores", async () => {
    mocks.queryRawUnsafe.mockResolvedValue([{ repoId: "r1", hybridScore: 0.8 }])

    const results = await searchReposByText("database", "user-1", 20, undefined, "hybrid")

    expect(results).toEqual([{ repoId: "r1", hybridScore: 0.8 }])
    expect(mocks.embeddingCreate).toHaveBeenCalledOnce()
    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ]
    expect(sql).toContain("* 0.7")
    expect(sql).toContain("* 0.3")
    expect(sql).toContain('"hybridScore" DESC')
    expect(sql).toContain("websearch_to_tsquery('english', $2)")
    expect(params).toEqual([
      "[0.1,0.2]",
      "database",
      "user-1",
      20,
    ])
  })

  it("scopes the summary LATERAL join to the current user in keyword and hybrid modes", async () => {
    mocks.queryRawUnsafe.mockResolvedValue([{ repoId: "r1" }])

    await searchReposByText("hello", "user-1", 20, undefined, "keyword")
    const keywordSql = mocks.queryRawUnsafe.mock.calls[0][0] as string
    // keyword params are [query, userId]; the join must read the userId at $2
    expect(keywordSql).toMatch(/LEFT JOIN LATERAL[\s\S]*?"userId" = \$2[\s\S]*?a ON true/)

    mocks.queryRawUnsafe.mockClear()
    await searchReposByText("hello", "user-1", 20, undefined, "hybrid")
    const hybridSql = mocks.queryRawUnsafe.mock.calls[0][0] as string
    // hybrid params are [vector, query, userId]; the join must read the userId at $3
    expect(hybridSql).toMatch(/LEFT JOIN LATERAL[\s\S]*?"userId" = \$3[\s\S]*?a ON true/)
    expect(hybridSql).not.toMatch(/LEFT JOIN LATERAL[\s\S]*?"userId" = \$2[\s\S]*?a ON true/)
  })
})

describe("search page/pageSize/threshold boundary normalization", () => {
  it("falls back to safe defaults for NaN/Infinity page values in searchReposPage", async () => {
    mocks.queryRawUnsafe.mockResolvedValue([])

    const posInf = await searchReposPage(
      "hello",
      "user-1",
      { page: Number.POSITIVE_INFINITY, pageSize: 5 },
      "keyword",
    )
    expect(posInf.page).toBe(1)
    expect(posInf.pageSize).toBe(5)

    const negInfSize = await searchReposPage(
      "hello",
      "user-1",
      { page: Number.NEGATIVE_INFINITY, pageSize: Number.POSITIVE_INFINITY },
      "keyword",
    )
    // Infinity is not finite, so it falls back to the default pageSize (20);
// only a finite oversized value is capped at 100.
    expect(negInfSize.page).toBe(1)
    expect(negInfSize.pageSize).toBe(20)

    const nanBoth = await searchReposPage(
      "hello",
      "user-1",
      { page: Number.NaN, pageSize: Number.NaN },
      "keyword",
    )
    expect(nanBoth.page).toBe(1)
    expect(nanBoth.pageSize).toBe(20)
  })

  it("caps searchReposPage pageSize at 100 and keeps valid page values", async () => {
    mocks.queryRawUnsafe.mockResolvedValue([])

    const r = await searchReposPage("hello", "user-1", { page: 4, pageSize: 250 }, "keyword")
    expect(r.page).toBe(4)
    expect(r.pageSize).toBe(100)

    const r2 = await searchReposPage("hello", "user-1", { page: -3, pageSize: 0 }, "keyword")
    expect(r2.page).toBe(1)
    expect(r2.pageSize).toBe(1)
  })

  it("normalizes asset page/pageSize and falls back to the default threshold", async () => {
    mocks.queryRawUnsafe.mockResolvedValue([])

    const r = await searchAssetsPage("hello", "user-1", {
      page: Number.NaN,
      pageSize: Number.NaN,
      threshold: Number.NaN,
    })
    expect(r.page).toBe(1)
    expect(r.pageSize).toBe(20)

    // No filters pushed: $1=vector, $2=userId, $3=threshold, $4=limit
    const rowsCall = mocks.queryRawUnsafe.mock.calls[0] as [string, ...unknown[]]
    expect(rowsCall[0]).toContain("> $3")
    expect(rowsCall[3]).toBe(0.3)
  })

  it("clamps a finite out-of-range asset threshold into [0, 1]", async () => {
    mocks.queryRawUnsafe.mockResolvedValue([])

    await searchAssetsPage("hello", "user-1", { pageSize: 5, threshold: 99 })
    const rowsCall = mocks.queryRawUnsafe.mock.calls[0] as [string, ...unknown[]]
    expect(rowsCall[3]).toBe(1)

    mocks.queryRawUnsafe.mockClear()
    await searchAssetsPage("hello", "user-1", { pageSize: 5, threshold: -0.5 })
    const clampCall = mocks.queryRawUnsafe.mock.calls[0] as [string, ...unknown[]]
    expect(clampCall[3]).toBe(0)
  })
})