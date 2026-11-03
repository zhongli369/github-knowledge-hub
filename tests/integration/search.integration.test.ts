import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const embeddingMock = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("@/lib/embeddings", () => ({
  embeddingsOpenAI: { embeddings: { create: embeddingMock.create } },
}))

import { prisma } from "@/lib/prisma"
import { searchReposByText } from "@/services/llm/repo-embedding.service"

function vector(index: number, value = 1): number[] {
  const values = Array<number>(1536).fill(0)
  values[index] = value
  return values
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`
}

async function insertEmbedding(repositoryId: string, values: number[]) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RepoEmbedding"
      ("id", "repositoryId", "vector", "model", "textHash", "createdAt", "updatedAt")
     VALUES ($1, $2, $3::vector, 'test-model', 'test', NOW(), NOW())`,
    `embedding-${repositoryId}`,
    repositoryId,
    vectorLiteral(values),
  )
}

const queryVector = vector(0)

beforeAll(async () => {
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(databaseName)) {
    throw new Error("Search tests refuse to run outside an isolated fresh test database")
  }

  const now = new Date()
  await prisma.user.createMany({
    data: [
      { id: "search-user-a", name: "User A", updatedAt: now },
      { id: "search-user-b", name: "User B", updatedAt: now },
    ],
  })
  await prisma.repository.createMany({
    data: [
      {
        id: "search-alpha", githubId: 1001, owner: "alice", name: "PostgreSQL Search",
        fullName: "alice/postgresql-search", description: "Vector database retrieval",
        url: "https://example.invalid/alpha", language: "TypeScript", stars: 50,
        topics: ["database", "search"], userId: "search-user-a", updatedAt: now,
      },
      {
        id: "search-beta", githubId: 1002, owner: "alice", name: "Cooking Recipes",
        fullName: "alice/cooking-recipes", description: "Meal planning",
        url: "https://example.invalid/beta", language: "Python", stars: 5,
        topics: ["cooking"], userId: "search-user-a", updatedAt: now,
      },
      {
        id: "search-keyword-only", githubId: 1003, owner: "alice", name: "Database Fallback",
        fullName: "alice/database-fallback", description: "Keyword-only database match",
        url: "https://example.invalid/keyword", language: "Python", stars: 1,
        topics: ["database"], userId: "search-user-a", updatedAt: now,
      },
      {
        id: "search-other-user", githubId: 1004, owner: "bob", name: "PostgreSQL Search",
        fullName: "bob/postgresql-search", description: "Another user's private database",
        url: "https://example.invalid/other", language: "TypeScript", stars: 99,
        topics: ["database"], userId: "search-user-b", updatedAt: now,
      },
      {
        id: "search-maintenance", githubId: 1005, owner: "alice", name: "Original Name",
        fullName: "alice/maintenance", description: "Original description",
        url: "https://example.invalid/maintenance", userId: "search-user-a", updatedAt: now,
      },
    ],
  })

  await insertEmbedding("search-alpha", vector(0))
  await insertEmbedding("search-beta", vector(1))
  await insertEmbedding("search-keyword-only", vector(0, -1))
  await insertEmbedding("search-other-user", vector(0))
})

beforeEach(() => {
  embeddingMock.create.mockReset()
  embeddingMock.create.mockResolvedValue({ data: [{ embedding: queryVector }] })
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe("repository search against isolated PostgreSQL", () => {
  it("performs keyword search with user isolation", async () => {
    const own = await searchReposByText("PostgreSQL", "search-user-a", 20, undefined, "keyword")
    expect(own.map((result) => result.repoId)).toEqual(["search-alpha"])

    const other = await searchReposByText("PostgreSQL", "search-user-b", 20, undefined, "keyword")
    expect(other.map((result) => result.repoId)).toEqual(["search-other-user"])

    expect(await searchReposByText("PostgreSQL", "missing-user", 20, undefined, "keyword")).toEqual([])
  })

  it("performs semantic search using a mocked deterministic embedding", async () => {
    const results = await searchReposByText("database", "search-user-a", 20, undefined, "semantic")
    expect(results.map((result) => result.repoId)).toEqual(["search-alpha"])
    expect(results[0].similarity).toBeCloseTo(1)
    expect(embeddingMock.create).toHaveBeenCalledOnce()
  })

  it("combines semantic and keyword matches in hybrid mode", async () => {
    const results = await searchReposByText("database", "search-user-a", 20, undefined, "hybrid")
    expect(new Set(results.map((result) => result.repoId))).toEqual(
      new Set(["search-alpha", "search-keyword-only"]),
    )
    expect(results[0].repoId).toBe("search-alpha")
    expect(results.some((result) => result.repoId === "search-other-user")).toBe(false)
  })

  it("applies language, stars and topic filters", async () => {
    const results = await searchReposByText(
      "database",
      "search-user-a",
      20,
      { language: "TypeScript", minStars: 10, topics: ["search"] },
      "hybrid",
    )
    expect(results.map((result) => result.repoId)).toEqual(["search-alpha"])
  })

  it("automatically maintains generated searchVector after updates", async () => {
    expect(await searchReposByText("Original", "search-user-a", 20, undefined, "keyword"))
      .toHaveLength(1)

    await prisma.repository.update({
      where: { id: "search-maintenance" },
      data: { name: "SQLite Knowledge", description: "Local index", topics: ["zig"] },
    })

    expect(await searchReposByText("Original", "search-user-a", 20, undefined, "keyword")).toEqual([])
    const updated = await searchReposByText("SQLite zig", "search-user-a", 20, undefined, "keyword")
    expect(updated.map((result) => result.repoId)).toEqual(["search-maintenance"])
  })

  it("returns empty results for empty queries, unknown users and invalid limits without API calls", async () => {
    for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      expect(await searchReposByText("  ", "search-user-a", 20, undefined, mode)).toEqual([])
      expect(await searchReposByText("database", "", 20, undefined, mode)).toEqual([])
      expect(await searchReposByText("database", "search-user-a", 0, undefined, mode)).toEqual([])
      expect(await searchReposByText("database", "search-user-a", -1, undefined, mode)).toEqual([])
      expect(await searchReposByText("database", "search-user-a", Number.NaN, undefined, mode)).toEqual([])
    }
    expect(embeddingMock.create).not.toHaveBeenCalled()
  })
})
