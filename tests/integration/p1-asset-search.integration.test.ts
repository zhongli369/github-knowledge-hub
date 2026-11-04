import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "node:crypto"

// ── Embeddings API mocked; Prisma + pgvector talk to the isolated fresh DB ──

const mocks = vi.hoisted(() => ({ embeddingCreate: vi.fn() }))

vi.mock("@/lib/embeddings", () => ({
  embeddingsOpenAI: { embeddings: { create: mocks.embeddingCreate } },
}))

import { prisma } from "@/lib/prisma"
import {
  searchSimilarAssets,
  searchByText,
  getSimilarAssets,
} from "@/services/llm/embeddings.service"
import {
  getSimilarRepos,
  checkEmbeddingFreshness,
} from "@/services/llm/repo-embedding.service"

function vector(index: number): number[] {
  const values = Array<number>(1536).fill(0)
  values[index] = 1
  return values
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`
}

const QUERY = vector(0)

async function insertAssetEmbedding(assetId: string, values: number[]) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Embedding" ("id", "assetId", "vector", "model", "createdAt")
     VALUES ($1, $2, $3::vector, 'test-model', NOW())`,
    `embed-${assetId}`,
    assetId,
    vectorLiteral(values),
  )
}

async function insertRepoEmbedding(
  repositoryId: string,
  values: number[],
  textHash = "test",
  updatedAt?: Date,
) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RepoEmbedding"
      ("id", "repositoryId", "vector", "model", "textHash", "createdAt", "updatedAt")
     VALUES ($1, $2, $3::vector, 'test-model', $4, NOW(), $5)
     ON CONFLICT ("repositoryId") DO UPDATE
     SET "vector" = $3::vector, "textHash" = $4, "updatedAt" = $5`,
    `re-embed-${repositoryId}`,
    repositoryId,
    vectorLiteral(values),
    textHash,
    updatedAt ?? new Date(),
  )
}

const now = () => new Date()

beforeAll(async () => {
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(databaseName)) {
    throw new Error("Asset search tests refuse to run outside an isolated fresh test database")
  }

  await prisma.user.createMany({
    data: [
      { id: "p1s-user-a", name: "Search User A", updatedAt: now() },
      { id: "p1s-user-b", name: "Search User B", updatedAt: now() },
    ],
  })
  await prisma.repository.createMany({
    data: [
      {
        id: "p1s-repo-a", githubId: 8201, owner: "alice", name: "P1 Search A",
        fullName: "alice/p1s-repo-a", description: "Vector retrieval",
        url: "https://example.invalid/p1s/a", language: "TypeScript", stars: 10,
        topics: ["search", "vector"], userId: "p1s-user-a", updatedAt: now(),
      },
      {
        id: "p1s-repo-b", githubId: 8202, owner: "alice", name: "P1 Search B",
        fullName: "alice/p1s-repo-b", description: "Another vector store",
        url: "https://example.invalid/p1s/b", language: "Python", stars: 3,
        topics: ["store"], userId: "p1s-user-a", updatedAt: now(),
      },
      {
        id: "p1s-repo-nembed", githubId: 8203, owner: "bob", name: "P1 No Embedding",
        fullName: "bob/p1s-repo-nembed", description: "No embedding yet",
        url: "https://example.invalid/p1s/n", language: "Rust", stars: 1,
        topics: ["tool"], userId: "p1s-user-a", updatedAt: now(),
      },
      {
        id: "p1s-repo-other", githubId: 8204, owner: "bob", name: "P1 Other User",
        fullName: "bob/p1s-repo-other", description: "Another user's source",
        url: "https://example.invalid/p1s/other", language: "Go", stars: 2,
        topics: ["private"], userId: "p1s-user-b", updatedAt: now(),
      },
    ],
  })

  await prisma.knowledgeAsset.createMany({
    data: [
      {
        id: "p1s-asset-algo", title: "quick-sort.ts", description: "sorting", assetType: "algorithm",
        sourcePath: "src/quick-sort.ts", content: "function quickSort(list) { return list }",
        summary: "In-place sort", language: "TypeScript", tags: ["algorithm", "sorting"],
        difficulty: "intermediate", repositoryId: "p1s-repo-a", userId: "p1s-user-a", updatedAt: now(),
      },
      {
        id: "p1s-asset-pattern", title: "factory.ts", description: "factory", assetType: "pattern",
        sourcePath: "src/factory.ts", content: "class Factory { }",
        language: "TypeScript", tags: ["design"], repositoryId: "p1s-repo-a", userId: "p1s-user-a", updatedAt: now(),
      },
      {
        id: "p1s-asset-api", title: "routes.ts", description: "http routes", assetType: "snippet",
        sourcePath: "src/routes.ts", content: "router.get('/', handler)",
        language: "TypeScript", tags: ["api"], repositoryId: "p1s-repo-a", userId: "p1s-user-a", updatedAt: now(),
      },
      {
        id: "p1s-asset-noembed", title: "README.md", description: "docs", assetType: "doc",
        sourcePath: "docs/README.md", content: "Project documentation",
        repositoryId: "p1s-repo-nembed", userId: "p1s-user-a", updatedAt: now(),
      },
      {
        id: "p1s-asset-other", title: "secret.ts", description: "other user", assetType: "algorithm",
        sourcePath: "src/secret.ts", content: "another algorithm",
        repositoryId: "p1s-repo-a", userId: "p1s-user-b", updatedAt: now(),
      },
    ],
  })

  await insertAssetEmbedding("p1s-asset-algo", vector(0))
  await insertAssetEmbedding("p1s-asset-pattern", vector(0))
  await insertAssetEmbedding("p1s-asset-api", vector(1))
  await insertAssetEmbedding("p1s-asset-other", vector(0))
})

beforeEach(() => {
  mocks.embeddingCreate.mockReset()
  mocks.embeddingCreate.mockResolvedValue({ data: [{ embedding: QUERY }] })
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe("asset-level semantic search", () => {
  it("returns only the requester's assets above the similarity threshold", async () => {
    const results = await searchSimilarAssets(QUERY, "p1s-user-a", 10)
    const ids = results.map((result) => result.assetId)

    expect(ids).toContain("p1s-asset-algo")
    expect(ids).toContain("p1s-asset-pattern")
    expect(ids).not.toContain("p1s-asset-api") // orthogonal -> similarity 0
    expect(ids).not.toContain("p1s-asset-other") // other user
    expect(ids).not.toContain("p1s-asset-noembed") // no embedding row
    expect(results[0].similarity).toBeCloseTo(1)
  })

  it("applies assetType, language, difficulty and tags filters", async () => {
    const byType = await searchSimilarAssets(QUERY, "p1s-user-a", 10, { assetType: "algorithm" })
    expect(byType.map((result) => result.assetId)).toEqual(["p1s-asset-algo"])

    const byLanguage = await searchSimilarAssets(QUERY, "p1s-user-a", 10, {
      language: "TypeScript",
    })
    expect(new Set(byLanguage.map((result) => result.assetId))).toEqual(
      new Set(["p1s-asset-algo", "p1s-asset-pattern"]),
    )

    const byDifficulty = await searchSimilarAssets(QUERY, "p1s-user-a", 10, {
      difficulty: "intermediate",
    })
    expect(byDifficulty.map((result) => result.assetId)).toEqual(["p1s-asset-algo"])

    const byTags = await searchSimilarAssets(QUERY, "p1s-user-a", 10, {
      tags: ["algorithm"],
    })
    expect(byTags.map((result) => result.assetId)).toEqual(["p1s-asset-algo"])
  })

  it("searchByText embeds the query through the mocked API then delegates", async () => {
    const results = await searchByText("quick sort", "p1s-user-a")

    expect(mocks.embeddingCreate).toHaveBeenCalledOnce()
    const ids = results.map((result) => result.assetId)
    expect(ids).toContain("p1s-asset-algo")
  })
})

describe("getSimilarAssets", () => {
  it("returns sibling assets and excludes the source and out-of-threshold rows", async () => {
    const results = await getSimilarAssets("p1s-asset-algo", "p1s-user-a", 5)
    expect(results.map((result) => result.assetId)).toEqual(["p1s-asset-pattern"])
  })

  it("returns an empty list when the source asset has no embedding", async () => {
    expect(await getSimilarAssets("p1s-asset-noembed", "p1s-user-a", 5)).toEqual([])
  })

  it("rejects a source asset owned by another user", async () => {
    expect(await getSimilarAssets("p1s-asset-other", "p1s-user-a", 5)).toEqual([])
  })
})

describe("similar repos", () => {
  beforeAll(async () => {
    await insertRepoEmbedding("p1s-repo-a", vector(0))
    await insertRepoEmbedding("p1s-repo-b", vector(0))
    await insertRepoEmbedding("p1s-repo-other", vector(0))
  })

  it("returns user-scoped similar repos excluding the target", async () => {
    const results = await getSimilarRepos("p1s-repo-a", "p1s-user-a", 5)
    expect(results.map((result) => result.repoId)).toEqual(["p1s-repo-b"])
  })

  it("rejects a source repository owned by another user", async () => {
    expect(await getSimilarRepos("p1s-repo-other", "p1s-user-a", 5)).toEqual([])
  })
})

describe("embedding freshness against the real database", () => {
  beforeAll(async () => {
    const creation = now()
    await prisma.analysis.create({
      data: {
        id: "p1s-ana-a",
        analysisType: "repo_summary",
        status: "completed",
        result: {
          summary: {
            oneLine: "one-line-summary",
            problem: "problem-summary",
            simpleExplanation: "explain-summary",
            reuseSuggestion: "reuse-summary",
          },
        },
        repositoryId: "p1s-repo-a",
        userId: "p1s-user-a",
        createdAt: new Date(creation.getTime() - 3_600_000),
        updatedAt: new Date(creation.getTime() - 3_600_000),
      },
    })
  })

  it("reports no embedding for a repository without one", async () => {
    const freshness = await checkEmbeddingFreshness("p1s-repo-nembed", "p1s-user-a")
    expect(freshness.hasEmbedding).toBe(false)
    expect(freshness.isStale).toBe(false)
  })

  it("reports an up-to-date embedding when the source text hash matches", async () => {
    const text = [
      "P1 Search A",
      "alice/p1s-repo-a",
      "Vector retrieval",
      "TypeScript",
      "search vector",
      "Summary: one-line-summary",
      "Problem: problem-summary",
      "Explanation: explain-summary",
      "Reuse: reuse-summary",
    ]
      .filter(Boolean)
      .join("\n")
    const exactHash = crypto.createHash("sha256").update(text).digest("hex")

    await insertRepoEmbedding("p1s-repo-a", vector(0), exactHash)

    const freshness = await checkEmbeddingFreshness("p1s-repo-a", "p1s-user-a")
    expect(freshness.hasEmbedding).toBe(true)
    expect(freshness.isStale).toBe(false)
    expect(freshness.lastSummaryAt).not.toBeNull()
  })

  it("reports a stale embedding when it predates the completed summary", async () => {
    await prisma.analysis.create({
      data: {
        id: "p1s-ana-b",
        analysisType: "repo_summary",
        status: "completed",
        result: { summary: { oneLine: "b-line" } },
        repositoryId: "p1s-repo-b",
        userId: "p1s-user-a",
      },
    })
    const stale = new Date(Date.now() - 7_200_000)
    await insertRepoEmbedding("p1s-repo-b", vector(0), "stale-hash", stale)

    const freshness = await checkEmbeddingFreshness("p1s-repo-b", "p1s-user-a")
    expect(freshness.hasEmbedding).toBe(true)
    expect(freshness.isStale).toBe(true)
  })
})