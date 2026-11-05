import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  fetchRepoReadme: vi.fn(),
}))

vi.mock("@/lib/openai", () => ({
  openai: { chat: { completions: { create: mocks.openaiCreate } } },
}))
vi.mock("@/services/github", () => ({ fetchRepoReadme: mocks.fetchRepoReadme }))

import { prisma } from "@/lib/prisma"
import {
  classifyRepository,
  ensureCategoryCollections,
} from "@/lib/classification/service"
import {
  listCategoryCollectionsForUser,
  listCategoryRepositoriesForUser,
  setRepositoryCategoryMembershipForUser,
} from "@/lib/collections/category"
import { REPO_CATEGORY_DEFINITIONS } from "@/lib/classification/taxonomy"

const USER_A = "classification-user-a"
const USER_B = "classification-user-b"
const REPO_MULTI = "classification-repo-multi"
const REPO_SUMMARY = "classification-repo-summary"
const REPO_OTHER_USER = "classification-repo-other-user"

beforeAll(async () => {
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(databaseName)) {
    throw new Error("Classification tests refuse to run outside an isolated fresh test database")
  }

  const now = new Date()
  await prisma.user.createMany({
    data: [
      { id: USER_A, name: "Classification User A", updatedAt: now },
      { id: USER_B, name: "Classification User B", updatedAt: now },
    ],
  })
  await prisma.repository.createMany({
    data: [
      {
        id: REPO_MULTI,
        githubId: 810001,
        owner: "alice",
        name: "agent-components",
        fullName: "alice/agent-components",
        description: "React UI components for LLM agents",
        url: "https://example.invalid/alice/agent-components",
        language: "TypeScript",
        stars: 25,
        topics: ["react", "llm"],
        userId: USER_A,
        updatedAt: now,
      },
      {
        id: REPO_SUMMARY,
        githubId: 810002,
        owner: "alice",
        name: "opaque-tool",
        fullName: "alice/opaque-tool",
        description: "A modular toolkit",
        url: "https://example.invalid/alice/opaque-tool",
        language: "Python",
        topics: ["productivity"],
        userId: USER_A,
        updatedAt: now,
      },
      {
        id: REPO_OTHER_USER,
        githubId: 810001,
        owner: "bob",
        name: "private-api",
        fullName: "bob/private-api",
        description: "Private REST API backend",
        url: "https://example.invalid/bob/private-api",
        language: "TypeScript",
        topics: ["api", "backend"],
        userId: USER_B,
        updatedAt: now,
      },
    ],
  })
  await prisma.analysis.create({
    data: {
      id: "classification-existing-summary",
      analysisType: "repo_summary",
      status: "completed",
      repositoryId: REPO_SUMMARY,
      userId: USER_A,
      result: {
        summary: {
          oneLine: "An LLM agent orchestration toolkit",
          techStack: ["Python"],
          scenarios: ["agent automation"],
        },
      },
    },
  })

  const legacyCollection = await prisma.collection.create({
    data: {
      id: "classification-legacy-collection",
      name: "Legacy Collection",
      description: "Must remain intact",
      userId: USER_A,
    },
  })
  const legacyAsset = await prisma.knowledgeAsset.create({
    data: {
      id: "classification-legacy-asset",
      title: "Legacy Asset",
      assetType: "doc",
      content: "Legacy content",
      tags: ["legacy"],
      repositoryId: REPO_MULTI,
      userId: USER_A,
    },
  })
  await prisma.collectionAsset.create({
    data: {
      id: "classification-legacy-link",
      collectionId: legacyCollection.id,
      assetId: legacyAsset.id,
      sortOrder: 4,
    },
  })
})

beforeEach(() => {
  mocks.openaiCreate.mockClear()
  mocks.fetchRepoReadme.mockReset()
  mocks.fetchRepoReadme.mockResolvedValue(null)
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe("repository functional classification against isolated PostgreSQL", () => {
  it("persists multi-category links without exposing another user's repositories", async () => {
    const outcome = await classifyRepository({ userId: USER_A, repositoryId: REPO_MULTI })
    expect(outcome.status).toBe("classified")
    expect(outcome.categorySlugs).toEqual(["ai-llm-agent", "frontend-ui"])

    const ownCategories = await listCategoryCollectionsForUser(USER_A)
    expect(ownCategories).toHaveLength(REPO_CATEGORY_DEFINITIONS.length)
    expect(ownCategories.filter((c) => c.repositoryCount === 1).map((c) => c.slug).sort())
      .toEqual(["ai-llm-agent", "frontend-ui"])
    expect(await prisma.collection.count({ where: { userId: USER_B } })).toBe(0)

    const ownRepos = await listCategoryRepositoriesForUser(USER_A, { slug: "ai-llm-agent" })
    expect(ownRepos.items.map((repo) => repo.id)).toEqual([REPO_MULTI])
    await expect(listCategoryRepositoriesForUser(USER_B, { slug: "ai-llm-agent" }))
      .rejects.toThrow("Category not found")

    const foreignOutcome = await classifyRepository({ userId: USER_A, repositoryId: REPO_OTHER_USER })
    expect(foreignOutcome.status).toBe("failed")
    expect(await prisma.repositoryClassification.count({ where: { repositoryId: REPO_OTHER_USER } })).toBe(0)

    const foreign = await classifyRepository({ userId: USER_B, repositoryId: REPO_OTHER_USER })
    expect(foreign.status).toBe("classified")
    const otherUserRepos = await listCategoryRepositoriesForUser(USER_B, { slug: "backend-api" })
    expect(otherUserRepos.items.map((repo) => repo.id)).toEqual([REPO_OTHER_USER])
    expect((await listCategoryRepositoriesForUser(USER_A, { slug: "backend-api" })).items).toEqual([])
  })

  it("preserves manual inclusion and exclusion across forced reclassification", async () => {
    await setRepositoryCategoryMembershipForUser(USER_A, {
      repositoryId: REPO_MULTI,
      slug: "devtools-cli",
      included: true,
    })
    await setRepositoryCategoryMembershipForUser(USER_A, {
      repositoryId: REPO_MULTI,
      slug: "frontend-ui",
      included: false,
    })

    const outcome = await classifyRepository({
      userId: USER_A,
      repositoryId: REPO_MULTI,
      force: true,
    })
    expect(outcome.status).toBe("classified")

    const links = await prisma.collectionRepository.findMany({
      where: {
        repositoryId: REPO_MULTI,
        collection: { userId: USER_A, slug: { in: ["ai-llm-agent", "frontend-ui", "devtools-cli"] } },
      },
      include: { collection: { select: { slug: true } } },
      orderBy: { collection: { slug: "asc" } },
    })
    expect(links.map((link) => ({
      slug: link.collection.slug,
      source: link.source,
      excluded: link.excluded,
    }))).toEqual([
      { slug: "ai-llm-agent", source: "auto", excluded: false },
      { slug: "devtools-cli", source: "manual", excluded: false },
      { slug: "frontend-ui", source: "manual", excluded: true },
    ])

    expect((await listCategoryRepositoriesForUser(USER_A, { slug: "devtools-cli" })).items)
      .toHaveLength(1)
    expect((await listCategoryRepositoriesForUser(USER_A, { slug: "frontend-ui" })).items)
      .toEqual([])
  })

  it("reuses an existing summary and skips unchanged content without another LLM call", async () => {
    const first = await classifyRepository({ userId: USER_A, repositoryId: REPO_SUMMARY })
    expect(first.status).toBe("classified")
    expect(first.categorySlugs).toContain("ai-llm-agent")
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
    expect(mocks.fetchRepoReadme).not.toHaveBeenCalled()

    const before = await prisma.repositoryClassification.findUniqueOrThrow({
      where: { repositoryId: REPO_SUMMARY },
    })
    const second = await classifyRepository({ userId: USER_A, repositoryId: REPO_SUMMARY })
    expect(second).toMatchObject({ status: "skipped", fromCache: true })
    expect(mocks.openaiCreate).not.toHaveBeenCalled()

    const after = await prisma.repositoryClassification.findUniqueOrThrow({
      where: { repositoryId: REPO_SUMMARY },
    })
    expect(after.contentHash).toBe(before.contentHash)
    expect(after.updatedAt).toEqual(before.updatedAt)
  })

  it("keeps legacy custom collections and asset relations unchanged", async () => {
    await ensureCategoryCollections(USER_A)
    const legacy = await prisma.collection.findUniqueOrThrow({
      where: { id: "classification-legacy-collection" },
      include: { assets: true },
    })
    expect(legacy).toMatchObject({ kind: "custom", slug: null, userId: USER_A })
    expect(legacy.assets).toHaveLength(1)
    expect(legacy.assets[0]).toMatchObject({
      id: "classification-legacy-link",
      assetId: "classification-legacy-asset",
      sortOrder: 4,
    })
    expect(await prisma.collection.count({
      where: { userId: USER_A, kind: "category" },
    })).toBe(REPO_CATEGORY_DEFINITIONS.length)
  })
})
