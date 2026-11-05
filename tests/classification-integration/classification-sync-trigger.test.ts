import { beforeEach, describe, expect, it, vi } from "vitest"

// ── External dependencies fully mocked; no real network or DB access ──
// Verifies the Agent D classification trigger chained onto the GitHub sync
// write path (`syncRepoToDb`): new rows enqueue `repo_classification`, and
// content-affecting metadata changes do too (Worker/Agent A re-check the hash).

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), // repository.findUnique (sync pre-check)
  upsert: vi.fn(),
  findMany: vi.fn(), // repository.findMany (unused here)
  repoFindFirst: vi.fn(), // repository.findFirst (enqueue ownership gate)
  analysisFindFirst: vi.fn(),
  analysisCreate: vi.fn(),
  rcFindUnique: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      findMany: mocks.findMany,
      findFirst: mocks.repoFindFirst,
    },
    analysis: { findFirst: mocks.analysisFindFirst, create: mocks.analysisCreate },
    repositoryClassification: { findUnique: mocks.rcFindUnique },
  },
}))

import { syncRepoToDb, type GitHubRepo } from "@/services/github/repos.service"

const ownedRepo = { id: "repo-1", owner: "octocat", name: "hello", fullName: "octocat/hello" }

function baseRepo(overrides: Partial<GitHubRepo> = {}): GitHubRepo {
  return {
    id: 123,
    owner: "octocat",
    name: "hello-world",
    fullName: "octocat/hello-world",
    description: "A demo repository",
    url: "https://github.com/octocat/hello-world",
    homepage: null,
    language: "TypeScript",
    stars: 50,
    forks: 4,
    topics: ["api", "demo"],
    defaultBranch: "main",
    isArchived: false,
    isTemplate: false,
    license: null,
    size: 200,
    pushedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.upsert.mockResolvedValue({ id: "db-repo" })
  mocks.repoFindFirst.mockResolvedValue(ownedRepo)
  mocks.analysisFindFirst.mockResolvedValue(null)
  mocks.analysisCreate.mockResolvedValue({ id: "classification-1" })
})

describe("syncRepoToDb triggers repo_classification", () => {
  it("enqueues classification when a new repository is created", async () => {
    mocks.findUnique.mockResolvedValue(null) // not present yet -> new row

    await syncRepoToDb("user-1", baseRepo())

    expect(mocks.analysisCreate).toHaveBeenCalledTimes(1)
    expect(mocks.analysisCreate).toHaveBeenCalledWith({
      data: {
        analysisType: "repo_classification",
        status: "pending",
        input: { mode: "all", force: false },
        repositoryId: "db-repo",
        userId: "user-1",
      },
    })
  })

  it("does not enqueue classification when metadata is unchanged", async () => {
    // Existing row with identical content-affecting metadata.
    mocks.findUnique.mockResolvedValue({
      id: "db-repo",
      description: "A demo repository",
      language: "TypeScript",
      topics: ["api", "demo"],
    })

    await syncRepoToDb("user-1", baseRepo())

    expect(mocks.upsert).toHaveBeenCalledTimes(1)
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })

  it.each([
    ["description change", { description: "A brand new demo" }],
    ["language change", { language: "Rust" }],
    ["topics change", { topics: ["api", "demo", "async"] }],
    ["topics reorder counts as unchanged", { topics: ["demo", "api"] }],
  ])("enqueues on %s", async (_label, changed) => {
    mocks.findUnique.mockResolvedValue({
      id: "db-repo",
      description: "A demo repository",
      language: "TypeScript",
      topics: ["api", "demo"],
    })

    await syncRepoToDb("user-1", baseRepo({ ...changed }))

    const shouldEnqueue = String(_label) !== "topics reorder counts as unchanged"
    if (shouldEnqueue) {
      expect(mocks.analysisCreate).toHaveBeenCalledTimes(1)
    } else {
      expect(mocks.analysisCreate).not.toHaveBeenCalled()
    }
  })

  it("does not enqueue when only non-content metadata (stars/forks) changed", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "db-repo",
      description: "A demo repository",
      language: "TypeScript",
      topics: ["api", "demo"],
    })

    await syncRepoToDb("user-1", baseRepo({ stars: 999, forks: 88 }))

    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })

  it("keeps the sync working when the classification enqueue fails", async () => {
    mocks.findUnique.mockResolvedValue(null) // new row
    mocks.repoFindFirst.mockRejectedValue(new Error("db unavailable"))

    await expect(syncRepoToDb("user-1", baseRepo())).resolves.toBeUndefined()
    expect(mocks.upsert).toHaveBeenCalledTimes(1)
  })
})