import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Category server actions; auth + lib mocked, no DB ──

const mocks = vi.hoisted(() => {
  const categoryLib = {
    listCategoryCollectionsForUser: vi.fn(),
    listCategoryRepositoriesForUser: vi.fn(),
    setRepositoryCategoryMembershipForUser: vi.fn(),
  }
  return {
    auth: vi.fn(),
    revalidatePath: vi.fn(),
    prisma: {},
    ensureCategoryCollections: vi.fn(),
    categoryLib,
  }
})

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }))
vi.mock("@/lib/classification/service", () => ({
  ensureCategoryCollections: mocks.ensureCategoryCollections,
}))
vi.mock("@/lib/collections/category", () => mocks.categoryLib)

import {
  listCategoryCollections,
  listCategoryRepositories,
  setRepositoryCategoryMembership,
} from "@/actions/collections"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
})

describe("listCategoryCollections", () => {
  it("delegates to the lib with the authenticated user id", async () => {
    mocks.categoryLib.listCategoryCollectionsForUser.mockResolvedValue([
      { id: "cat-1", slug: "ai-tools", name: "AI Tools", description: null, repositoryCount: 0 },
    ])

    const result = await listCategoryCollections("zh")

    expect(mocks.ensureCategoryCollections).toHaveBeenCalledWith("user-1")
    expect(mocks.categoryLib.listCategoryCollectionsForUser).toHaveBeenCalledWith("user-1")
    expect(result).toEqual([
      { id: "cat-1", slug: "ai-tools", name: "AI Tools", description: null, repositoryCount: 0 },
    ])
  })

  it("maps stable category slugs to English display text", async () => {
    mocks.categoryLib.listCategoryCollectionsForUser.mockResolvedValue([
      { id: "cat-1", slug: "backend-api", name: "后端 / API", description: "服务端逻辑", repositoryCount: 2 },
    ])

    const result = await listCategoryCollections("en")

    expect(result[0]).toMatchObject({
      slug: "backend-api",
      name: "Backend / API",
      description: "Server-side logic, APIs, protocols and integrations",
      repositoryCount: 2,
    })
  })

  it("is callable without a locale", async () => {
    mocks.categoryLib.listCategoryCollectionsForUser.mockResolvedValue([])

    await listCategoryCollections()

    expect(mocks.categoryLib.listCategoryCollectionsForUser).toHaveBeenCalledWith("user-1")
  })

  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue({ user: undefined })

    await expect(listCategoryCollections()).rejects.toThrow("Not authenticated")
    expect(mocks.ensureCategoryCollections).not.toHaveBeenCalled()
    expect(mocks.categoryLib.listCategoryCollectionsForUser).not.toHaveBeenCalled()
  })
})

describe("listCategoryRepositories", () => {
  it("delegates with the authenticated user id and the raw query", async () => {
    const query = { slug: "ai-tools", search: "hook", sort: "stars" as const, page: 2, pageSize: 30 }
    mocks.categoryLib.listCategoryRepositoriesForUser.mockResolvedValue({
      category: { id: "cat-1", slug: "ai-tools", name: "AI Tools", description: null, repositoryCount: 1 },
      items: [],
      total: 0,
      page: 2,
      pageSize: 30,
      languages: [],
    })

    const result = await listCategoryRepositories(query)

    expect(mocks.categoryLib.listCategoryRepositoriesForUser).toHaveBeenCalledWith("user-1", query)
    expect(result.total).toBe(0)
  })

  it("rejects unauthenticated callers before delegating", async () => {
    mocks.auth.mockResolvedValue({ user: undefined })

    await expect(listCategoryRepositories({ slug: "ai-tools" })).rejects.toThrow(
      "Not authenticated"
    )
    expect(mocks.categoryLib.listCategoryRepositoriesForUser).not.toHaveBeenCalled()
  })
})

describe("setRepositoryCategoryMembership", () => {
  it("delegates with the authenticated user id and normalized args", async () => {
    mocks.categoryLib.setRepositoryCategoryMembershipForUser.mockResolvedValue({ success: true })
    const args = { repositoryId: "repo-1", slug: "ai-tools", included: true }

    const result = await setRepositoryCategoryMembership(args)

    expect(result).toEqual({ success: true })
    expect(mocks.categoryLib.setRepositoryCategoryMembershipForUser).toHaveBeenCalledWith(
      "user-1",
      args
    )
  })

  it("rejects unauthenticated callers (no mutation can leak)", async () => {
    mocks.auth.mockResolvedValue({ user: undefined })

    await expect(
      setRepositoryCategoryMembership({ repositoryId: "repo-1", slug: "ai-tools", included: false })
    ).rejects.toThrow("Not authenticated")
    expect(mocks.categoryLib.setRepositoryCategoryMembershipForUser).not.toHaveBeenCalled()
  })
})