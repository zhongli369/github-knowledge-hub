import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Category collections lib; prisma mocked, no real DB ──

const mocks = vi.hoisted(() => {
  const db = {
    collection: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    repository: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    analysis: {
      findMany: vi.fn(),
    },
    collectionRepository: {
      upsert: vi.fn(),
    },
  }
  return { db }
})

vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }))

import {
  listCategoryCollectionsForUser,
  listCategoryRepositoriesForUser,
  setRepositoryCategoryMembershipForUser,
} from "@/lib/collections/category"

const NOW = new Date("2026-01-01T00:00:00.000Z")

function categoryFixture() {
  return { id: "cat-1", slug: "ai-tools", name: "AI Tools", description: "Tools for AI" }
}

function repoFixture(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `name-${id}`,
    fullName: `alice/${id}`,
    description: `description ${id}`,
    url: `https://github.com/alice/${id}`,
    language: "TypeScript",
    stars: 5,
    topics: ["typescript"],
    note: null,
    status: "new",
    pushedAt: null,
    lastFetchedAt: NOW,
    collectionLinks: [{ source: "auto", excluded: false }],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── listCategoryCollectionsForUser ────────────────────────────────

describe("listCategoryCollectionsForUser", () => {
  it("returns category summaries with included-only repository counts", async () => {
    mocks.db.collection.findMany.mockResolvedValue([
      { id: "cat-1", slug: "ai-tools", name: "AI Tools", description: null, _count: { repositories: 3 } },
    ])

    const result = await listCategoryCollectionsForUser("user-1")

    expect(result).toEqual([
      { id: "cat-1", slug: "ai-tools", name: "AI Tools", description: null, repositoryCount: 3 },
    ])
    expect(mocks.db.collection.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "category" },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        _count: { select: { repositories: { where: { excluded: false } } } },
      },
      orderBy: { name: "asc" },
    })
  })

  it("falls back to the collection id as slug for category rows without a slug", async () => {
    mocks.db.collection.findMany.mockResolvedValue([
      { id: "cat-1", slug: null, name: "Legacy", description: "d", _count: { repositories: 1 } },
    ])

    const result = await listCategoryCollectionsForUser("user-1")

    expect(result[0]).toMatchObject({ id: "cat-1", slug: "cat-1", repositoryCount: 1 })
  })

  it("is scoped to the requesting user", async () => {
    mocks.db.collection.findMany.mockResolvedValue([])

    await listCategoryCollectionsForUser("user-b")

    expect(mocks.db.collection.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "user-b",
      kind: "category",
    })
  })
})

// ── listCategoryRepositoriesForUser ───────────────────────────────

describe("listCategoryRepositoriesForUser", () => {
  it("pages through owned repos with search/language filters, sort and summary", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(categoryFixture())
    mocks.db.repository.count
      .mockResolvedValueOnce(2) // total (filtered)
      .mockResolvedValueOnce(5) // repositoryCount (category-wide, included)
    mocks.db.repository.findMany
      .mockResolvedValueOnce([{ language: "Python" }, { language: "TypeScript" }]) // language rows
      .mockResolvedValueOnce([
        repoFixture("repo-1", {
          topics: ["typescript", "tools"],
          stars: 42,
          note: "great",
          status: "active",
          collectionLinks: [{ source: "manual", excluded: false }],
        }),
        repoFixture("repo-2", {
          name: "py-scripts",
          fullName: "alice/py-scripts",
          language: "Python",
          stars: 10,
          pushedAt: NOW,
          collectionLinks: [{ source: "auto", excluded: false }],
        }),
      ])
    mocks.db.analysis.findMany.mockResolvedValue([
      {
        repositoryId: "repo-1",
        status: "completed",
        result: {
          summary: {
            oneLine: "TS tooling made simple",
            techStack: ["TypeScript", "React"],
            scenarios: ["CLI", "React"],
          },
        },
      },
    ])

    const result = await listCategoryRepositoriesForUser("user-1", {
      slug: "ai-tools",
      search: "tool",
      language: "TypeScript",
      sort: "stars",
      page: 1,
      pageSize: 20,
    })

    expect(result.category).toEqual({
      id: "cat-1",
      slug: "ai-tools",
      name: "AI Tools",
      description: "Tools for AI",
      repositoryCount: 5,
    })
    expect(result.total).toBe(2)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(20)
    expect(result.languages).toEqual(["Python", "TypeScript"])

    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      id: "repo-1",
      fullName: "alice/repo-1",
      stars: 42,
      note: "great",
      status: "active",
      summary: "TS tooling made simple",
      classifierSource: "manual",
      updatedAt: NOW.toISOString(),
    })
    // keywords = topics + summary techStack/scenarios, deduped & capped
    expect(result.items[0].keywords).toEqual(["typescript", "tools", "TypeScript", "React", "CLI"])
    expect(result.items[1]).toMatchObject({
      id: "repo-2",
      summary: null,
      classifierSource: "auto",
    })
  })

  it("never includes excluded memberships in any query (no leak of manual excludes)", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(categoryFixture())
    mocks.db.repository.count.mockResolvedValue(0)
    mocks.db.repository.findMany.mockResolvedValue([])

    await listCategoryRepositoriesForUser("user-1", { slug: "ai-tools" })

    // count (both total and repositoryCount) and list queries all filter
    // collectionLinks.some.excluded=false
    for (const call of mocks.db.repository.count.mock.calls) {
      expect(call[0]?.where?.collectionLinks).toEqual({
        some: { collectionId: "cat-1", excluded: false },
      })
    }
    const listCall = mocks.db.repository.findMany.mock.calls[1]
    expect(listCall[0]?.where?.collectionLinks).toEqual({
      some: { collectionId: "cat-1", excluded: false },
    })
  })

  it("throws Category not found when the slug is not one of the user's categories", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(null)

    await expect(
      listCategoryRepositoriesForUser("user-b", { slug: "ai-tools" })
    ).rejects.toThrow("Category not found")
    expect(mocks.db.repository.findMany).not.toHaveBeenCalled()
  })

  it("clamps page/pageSize and falls back invalid sort to updated", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(categoryFixture())
    mocks.db.repository.count.mockResolvedValue(0)
    mocks.db.repository.findMany.mockResolvedValue([])

    const result = await listCategoryRepositoriesForUser("user-1", {
      slug: "ai-tools",
      page: 0,
      pageSize: 999,
      sort: "bogus",
    })

    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(100) // clamped to MAX_PAGE_SIZE
    const listCall = mocks.db.repository.findMany.mock.calls[1]
    expect(listCall[0]?.orderBy).toEqual([
      { pushedAt: { sort: "desc", nulls: "last" } },
      { lastFetchedAt: "desc" },
      { fullName: "asc" },
    ])
    expect(result.items).toEqual([])
    expect(mocks.db.analysis.findMany).not.toHaveBeenCalled()
  })

  it("uses only completed repo_summary results as the summary", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(categoryFixture())
    mocks.db.repository.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
    mocks.db.repository.findMany
      .mockResolvedValueOnce([]) // language rows
      .mockResolvedValueOnce([repoFixture("repo-1", { collectionLinks: [{ source: "auto", excluded: false }] })])
    mocks.db.analysis.findMany.mockResolvedValue([
      {
        repositoryId: "repo-1",
        status: "failed",
        result: { summary: { oneLine: "should be ignored" } },
      },
    ])

    const result = await listCategoryRepositoriesForUser("user-1", { slug: "ai-tools" })

    expect(result.items[0].summary).toBeNull()
    expect(result.items[0].classifierSource).toBe("auto")
    // The DB query only ever fetches completed repo_summary rows.
    expect(mocks.db.analysis.findMany).toHaveBeenCalledWith({
      where: {
        repositoryId: { in: ["repo-1"] },
        userId: "user-1",
        analysisType: "repo_summary",
        status: "completed",
      },
      select: { repositoryId: true, status: true, result: true },
      distinct: ["repositoryId"],
      orderBy: { createdAt: "desc" },
    })
  })

  it("does not let a newer failed/running repo_summary shadow a prior completed summary", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(categoryFixture())
    mocks.db.repository.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
    mocks.db.repository.findMany
      .mockResolvedValueOnce([]) // language rows
      .mockResolvedValueOnce([repoFixture("repo-1", { collectionLinks: [{ source: "auto", excluded: false }] })])
    // Simulates the DB having filtered to status="completed": only the older
    // completed row survives, even though a newer failed row exists in reality.
    mocks.db.analysis.findMany.mockResolvedValue([
      {
        repositoryId: "repo-1",
        status: "completed",
        createdAt: new Date("2025-12-01T00:00:00.000Z"),
        result: {
          summary: { oneLine: "the completed summary", techStack: ["Go"] },
        },
      },
    ])

    const result = await listCategoryRepositoriesForUser("user-1", { slug: "ai-tools" })

    expect(result.items[0].summary).toBe("the completed summary")
    expect(mocks.db.analysis.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      repositoryId: { in: ["repo-1"] },
      userId: "user-1",
      analysisType: "repo_summary",
      status: "completed",
    })
  })
})

// ── setRepositoryCategoryMembershipForUser ────────────────────────

describe("setRepositoryCategoryMembershipForUser", () => {
  it("manually includes a repo (source=manual, excluded=false)", async () => {
    mocks.db.repository.findFirst.mockResolvedValue({ id: "repo-1" })
    mocks.db.collection.findFirst.mockResolvedValue(categoryFixture())
    mocks.db.collectionRepository.upsert.mockResolvedValue({ id: "row-1" })

    const result = await setRepositoryCategoryMembershipForUser("user-1", {
      repositoryId: "repo-1",
      slug: "ai-tools",
      included: true,
    })

    expect(result).toEqual({ success: true })
    expect(mocks.db.collectionRepository.upsert).toHaveBeenCalledWith({
      where: {
        collectionId_repositoryId: { collectionId: "cat-1", repositoryId: "repo-1" },
      },
      create: { collectionId: "cat-1", repositoryId: "repo-1", source: "manual", excluded: false },
      update: { source: "manual", excluded: false },
    })
  })

  it("manually excludes a repo and flips any auto row to manual (excluded=true)", async () => {
    mocks.db.repository.findFirst.mockResolvedValue({ id: "repo-1" })
    mocks.db.collection.findFirst.mockResolvedValue(categoryFixture())
    mocks.db.collectionRepository.upsert.mockResolvedValue({ id: "row-1" })

    const result = await setRepositoryCategoryMembershipForUser("user-1", {
      repositoryId: "repo-1",
      slug: "ai-tools",
      included: false,
    })

    expect(result).toEqual({ success: true })
    expect(mocks.db.collectionRepository.upsert).toHaveBeenCalledWith({
      where: {
        collectionId_repositoryId: { collectionId: "cat-1", repositoryId: "repo-1" },
      },
      create: { collectionId: "cat-1", repositoryId: "repo-1", source: "manual", excluded: true },
      update: { source: "manual", excluded: true },
    })
  })

  it("throws Repository not found when the repo belongs to another user", async () => {
    mocks.db.repository.findFirst.mockResolvedValue(null)

    await expect(
      setRepositoryCategoryMembershipForUser("user-b", {
        repositoryId: "repo-of-a",
        slug: "ai-tools",
        included: true,
      })
    ).rejects.toThrow("Repository not found")
    expect(mocks.db.collectionRepository.upsert).not.toHaveBeenCalled()
  })

  it("throws Category not found when the category belongs to another user", async () => {
    mocks.db.repository.findFirst.mockResolvedValue({ id: "repo-1" })
    mocks.db.collection.findFirst.mockResolvedValue(null)

    await expect(
      setRepositoryCategoryMembershipForUser("user-b", {
        repositoryId: "repo-1",
        slug: "ai-tools",
        included: false,
      })
    ).rejects.toThrow("Category not found")
    expect(mocks.db.collectionRepository.upsert).not.toHaveBeenCalled()
  })

  it("validates arguments before touching the database", async () => {
    await expect(
      setRepositoryCategoryMembershipForUser("user-1", {
        repositoryId: "",
        slug: "ai-tools",
        included: true,
      })
    ).rejects.toThrow("repositoryId is required")
    expect(mocks.db.repository.findFirst).not.toHaveBeenCalled()
  })
})