import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// ── Embeddings API mocked; Prisma + pgvector talk to the isolated fresh DB ──

const mocks = vi.hoisted(() => ({ embeddingCreate: vi.fn() }))

vi.mock("@/lib/embeddings", () => ({
  embeddingsOpenAI: { embeddings: { create: mocks.embeddingCreate } },
}))

import { prisma } from "@/lib/prisma"
import { searchReposPage } from "@/services/llm/repo-embedding.service"
import { searchAssetsPage } from "@/services/llm/embeddings.service"

function vector(index: number): number[] {
  const values = Array<number>(1536).fill(0)
  values[index] = 1
  return values
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`
}

const QUERY = vector(0)

async function insertRepoEmbedding(repositoryId: string, values: number[]) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RepoEmbedding"
      ("id", "repositoryId", "vector", "model", "textHash", "createdAt", "updatedAt")
     VALUES ($1, $2, $3::vector, 'test-model', 'hash', NOW(), NOW())
     ON CONFLICT ("repositoryId") DO UPDATE
     SET "vector" = $3::vector, "textHash" = 'hash', "updatedAt" = NOW()`,
    `p2d-reembed-${repositoryId}`,
    repositoryId,
    vectorLiteral(values),
  )
}

async function insertAssetEmbedding(assetId: string, values: number[]) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Embedding" ("id", "assetId", "vector", "model", "createdAt")
     VALUES ($1, $2, $3::vector, 'test-model', NOW())`,
    `p2d-aembed-${assetId}`,
    assetId,
    vectorLiteral(values),
  )
}

const now = () => new Date()

const REPO_COUNT = 15

beforeAll(async () => {
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(databaseName)) {
    throw new Error("P2 Discover pagination tests refuse to run outside an isolated fresh test database")
  }

  await prisma.user.create({
    data: { id: "p2d-user-a", name: "P2 Discover User", updatedAt: now() },
  })

  // 15 repos that all match the "paginate" query; distinct languages and stars.
  await prisma.repository.createMany({
    data: Array.from({ length: REPO_COUNT }, (_, i) => {
      const n = i + 1
      return {
        id: `p2d-repo-${String(n).padStart(2, "0")}`,
        githubId: 9000 + n,
        owner: "p2d",
        name: `sample-${n}`,
        fullName: `p2d/repo-${String(n).padStart(2, "0")}`,
        description: "paginate me",
        url: `https://example.invalid/p2d/${n}`,
        language: n % 2 === 1 ? "TypeScript" : "Python",
        stars: n * 10,
        topics: ["paginate"],
        userId: "p2d-user-a",
        updatedAt: now(),
      }
    }),
  })

  // All repos have embeddings so semantic/hybrid count paths are exercised too.
  for (let i = 1; i <= REPO_COUNT; i++) {
    await insertRepoEmbedding(`p2d-repo-${String(i).padStart(2, "0")}`, vector(0))
  }

  // 12 assets: #1 and #2 algorithm, the rest snippet, all tagged "paginate".
  await prisma.knowledgeAsset.createMany({
    data: Array.from({ length: 12 }, (_, i) => {
      const n = i + 1
      return {
        id: `p2d-asset-${String(n).padStart(2, "0")}`,
        title: `asset-${String(n).padStart(2, "0")}`,
        description: "paginate asset",
        assetType: n <= 2 ? "algorithm" : "snippet",
        sourcePath: `src/asset-${n}.ts`,
        content: `function asset${n}() { paginate everything }`,
        summary: `Paginate helper ${n}`,
        language: "TypeScript",
        tags: ["paginate"],
        difficulty: "intermediate",
        repositoryId: "p2d-repo-01",
        userId: "p2d-user-a",
        updatedAt: now(),
      }
    }),
  })

  for (let i = 1; i <= 12; i++) {
    await insertAssetEmbedding(`p2d-asset-${String(i).padStart(2, "0")}`, vector(0))
  }
})

beforeEach(() => {
  mocks.embeddingCreate.mockReset()
  mocks.embeddingCreate.mockResolvedValue({ data: [{ embedding: QUERY }] })
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe("p2 repo search pagination and sorting", () => {
  it("returns total + per-page items and correct hasMore flags", async () => {
    const page1 = await searchReposPage("paginate", "p2d-user-a", { page: 1, pageSize: 5 }, "keyword")
    expect(page1.items).toHaveLength(5)
    expect(page1.total).toBe(REPO_COUNT)
    expect(page1.hasMore).toBe(true)
    expect(page1.page).toBe(1)

    const page3 = await searchReposPage("paginate", "p2d-user-a", { page: 3, pageSize: 5 }, "keyword")
    expect(page3.items).toHaveLength(5)
    expect(page3.hasMore).toBe(false) // 3 * 5 === 15

    const page4 = await searchReposPage("paginate", "p2d-user-a", { page: 4, pageSize: 5 }, "keyword")
    expect(page4.items).toHaveLength(0)
    expect(page4.total).toBe(REPO_COUNT)
    expect(page4.hasMore).toBe(false)
  })

  it("sorts by stars descending and by name ascending", async () => {
    const byStars = await searchReposPage("paginate", "p2d-user-a", { pageSize: REPO_COUNT, sort: "stars" }, "keyword")
    expect(byStars.items[0].repoId).toBe("p2d-repo-15")
    expect(byStars.items[0].stars).toBe(150)

    const byName = await searchReposPage("paginate", "p2d-user-a", { pageSize: REPO_COUNT, sort: "name" }, "keyword")
    expect(byName.items[0].fullName).toBe("p2d/repo-01")
    expect(byName.items[byName.items.length - 1].fullName).toBe("p2d/repo-15")
  })

  it("honours filters together with pagination", async () => {
    const ts = await searchReposPage(
      "paginate",
      "p2d-user-a",
      { page: 1, pageSize: 3, filters: { language: "TypeScript" } },
      "keyword",
    )
    // Odd indices 1..15 => 8 TypeScript repos.
    expect(ts.total).toBe(8)
    expect(ts.items).toHaveLength(3)
    expect(ts.items.every((r) => r.language === "TypeScript")).toBe(true)

    const page3 = await searchReposPage(
      "paginate",
      "p2d-user-a",
      { page: 3, pageSize: 3, filters: { language: "TypeScript" } },
      "keyword",
    )
    expect(page3.items).toHaveLength(2)
    expect(page3.hasMore).toBe(false)
  })

  it("caps pageSize at 100 and clamps invalid page values", async () => {
    const big = await searchReposPage("paginate", "p2d-user-a", { pageSize: 999 }, "keyword")
    expect(big.pageSize).toBe(100)
    expect(big.items).toHaveLength(REPO_COUNT)

    const clampedPage = await searchReposPage("paginate", "p2d-user-a", { page: -3, pageSize: 5 }, "keyword")
    expect(clampedPage.page).toBe(1)

    const empty = await searchReposPage("  ", "p2d-user-a", {}, "keyword")
    expect(empty.items).toEqual([])
    expect(empty.total).toBe(0)
  })

  it("returns user-scoped rows in semantic mode with mocked embedding", async () => {
    const page = await searchReposPage("paginate", "p2d-user-a", { page: 1, pageSize: 6 }, "semantic")
    expect(mocks.embeddingCreate).toHaveBeenCalledOnce()
    expect(page.total).toBe(REPO_COUNT)
    expect(page.items).toHaveLength(6)
    expect(page.hasMore).toBe(true)

    const otherUser = await searchReposPage("paginate", "missing-user", {}, "semantic")
    expect(otherUser.items).toEqual([])
  })

  it("resolves the current user's repo summary in hybrid mode and never leaks another user's", async () => {
    // User A's completed repo summary so the hybrid join has something to resolve.
    await prisma.analysis.create({
      data: {
        id: "p2d-summary-a-01",
        repositoryId: "p2d-repo-01",
        userId: "p2d-user-a",
        analysisType: "repo_summary",
        status: "completed",
        result: { summary: { oneLine: "User A repo one helper" } },
      },
    })

    // A second user with their own summary; must stay invisible to user A.
    await prisma.user.create({
      data: { id: "p2d-user-b", name: "P2 Discover User B", updatedAt: now() },
    })
    await prisma.repository.create({
      data: {
        id: "p2d-repo-b-01",
        githubId: 9100,
        owner: "p2d",
        name: "sample-b",
        fullName: "p2d/repo-b-01",
        description: "paginate me",
        url: "https://example.invalid/p2d/b1",
        language: "Go",
        stars: 5,
        topics: ["paginate"],
        userId: "p2d-user-b",
        updatedAt: now(),
      },
    })
    await insertRepoEmbedding("p2d-repo-b-01", vector(0))
    await prisma.analysis.create({
      data: {
        id: "p2d-summary-b-01",
        repositoryId: "p2d-repo-b-01",
        userId: "p2d-user-b",
        analysisType: "repo_summary",
        status: "completed",
        result: { summary: { oneLine: "USER-B-LEAK-MARKER" } },
      },
    })

    // Hybrid params are [vector, query, userId]; the summary join must target user A ($3),
    // not the query text. Buggy behaviour would resolve no summary (all null).
    const hybrid = await searchReposPage(
      "paginate",
      "p2d-user-a",
      { pageSize: 50, sort: "stars" },
      "hybrid",
    )
    const repo01 = hybrid.items.find((r) => r.repoId === "p2d-repo-01")
    expect(repo01?.summaryOneLine).toBe("User A repo one helper")
    expect(hybrid.items.some((r) => r.repoId === "p2d-repo-b-01")).toBe(false)
    expect(hybrid.items.some((r) => r.summaryOneLine === "USER-B-LEAK-MARKER")).toBe(false)
  })
})

describe("p2 asset search pagination and sorting", () => {
  it("returns total + per-page items for assets", async () => {
    const page1 = await searchAssetsPage("paginate", "p2d-user-a", { page: 1, pageSize: 5 })
    expect(page1.items).toHaveLength(5)
    expect(page1.total).toBe(12)
    expect(page1.hasMore).toBe(true)

    const page3 = await searchAssetsPage("paginate", "p2d-user-a", { page: 3, pageSize: 5 })
    expect(page3.items).toHaveLength(2)
    expect(page3.hasMore).toBe(false)
  })

  it("sorts assets by title", async () => {
    const sorted = await searchAssetsPage("paginate", "p2d-user-a", { pageSize: 12, sort: "title" })
    expect(sorted.items[0].title).toBe("asset-01")
    expect(sorted.items[sorted.items.length - 1].title).toBe("asset-12")
  })

  it("applies assetType filters and keeps user isolation", async () => {
    const algorithms = await searchAssetsPage("paginate", "p2d-user-a", {
      pageSize: 12,
      filters: { assetType: "algorithm" },
    })
    expect(algorithms.total).toBe(2)
    expect(algorithms.items.every((a) => a.assetType === "algorithm")).toBe(true)

    const otherUser = await searchAssetsPage("paginate", "missing-user", {})
    expect(otherUser.items).toEqual([])
    expect(otherUser.total).toBe(0)
  })
})