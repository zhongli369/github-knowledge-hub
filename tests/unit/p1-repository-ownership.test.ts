import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Repository ownership guard (P1 Agent A) with mocked Prisma ──

const mocks = vi.hoisted(() => ({
  repoFindFirst: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findFirst: mocks.repoFindFirst },
  },
}))

import {
  getOwnedRepositoryMeta,
  assertRepositoryOwned,
  RepositoryNotOwnedError,
  REPOSITORY_NOT_OWNED_MESSAGE,
} from "@/services/intake/repository-ownership"

const owned = { id: "repo-1", owner: "alice", name: "hello", fullName: "alice/hello" }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getOwnedRepositoryMeta", () => {
  it("returns metadata for a repository the user owns", async () => {
    mocks.repoFindFirst.mockResolvedValue(owned)

    const result = await getOwnedRepositoryMeta("repo-1", "user-1")

    expect(result).toEqual(owned)
    expect(mocks.repoFindFirst).toHaveBeenCalledWith({
      where: { id: "repo-1", userId: "user-1" },
      select: { id: true, owner: true, name: true, fullName: true },
    })
  })

  it("returns null for a foreign / missing repository", async () => {
    mocks.repoFindFirst.mockResolvedValue(null)

    expect(await getOwnedRepositoryMeta("repo-other", "user-1")).toBeNull()
  })

  it("returns null without querying when input is empty", async () => {
    expect(await getOwnedRepositoryMeta("", "user-1")).toBeNull()
    expect(await getOwnedRepositoryMeta("repo-1", "")).toBeNull()
    expect(mocks.repoFindFirst).not.toHaveBeenCalled()
  })
})

describe("assertRepositoryOwned", () => {
  it("resolves for an owned repository", async () => {
    mocks.repoFindFirst.mockResolvedValue(owned)

    await expect(assertRepositoryOwned("repo-1", "user-1")).resolves.toEqual(owned)
  })

  it("throws RepositoryNotOwnedError for a foreign / missing repository", async () => {
    mocks.repoFindFirst.mockResolvedValue(null)

    await expect(assertRepositoryOwned("repo-other", "user-1")).rejects.toThrow(
      REPOSITORY_NOT_OWNED_MESSAGE,
    )
    await expect(assertRepositoryOwned("repo-other", "user-1")).rejects.toBeInstanceOf(
      RepositoryNotOwnedError,
    )
  })

  it("throws RepositoryNotOwnedError for a missing repositoryId", async () => {
    await expect(assertRepositoryOwned(null, "user-1")).rejects.toThrow(
      REPOSITORY_NOT_OWNED_MESSAGE,
    )
    expect(mocks.repoFindFirst).not.toHaveBeenCalled()
  })

  // The worker (P1 Agent B) uses this guard as the pre-execution
  // repository.userId === analysis.userId check for a claimed task.
  it("can act as the worker's claimed-task ownership check", async () => {
    mocks.repoFindFirst.mockResolvedValue(owned)

    await expect(assertRepositoryOwned("repo-1", "alice")).resolves.toMatchObject({
      owner: "alice",
      fullName: "alice/hello",
    })
  })
})