import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Queue dedup + ownership logic with mocked Prisma; no real DB access ──

const mocks = vi.hoisted(() => ({
  repoFindFirst: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findFirst: mocks.repoFindFirst },
    analysis: { findFirst: mocks.findFirst, create: mocks.create },
  },
}))

import {
  enqueueRepoSummary,
  enqueueAssetExtraction,
  REPOSITORY_NOT_FOUND_ERROR,
} from "@/services/intake/enqueue-analysis"

const ownedRepo = { id: "repo-1", owner: "alice", name: "hello", fullName: "alice/hello" }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repoFindFirst.mockResolvedValue(ownedRepo)
  mocks.create.mockImplementation(async (args: unknown) => ({
    id: "new-analysis",
    ...(args as { data?: { analysisType?: string } }).data,
  }))
})

describe("ownership gate", () => {
  it.each([
    ["repo_summary", enqueueRepoSummary],
    ["asset_extraction", enqueueAssetExtraction],
  ])("refuses to enqueue %s for a repository the user does not own", async (_type, fn) => {
    mocks.repoFindFirst.mockResolvedValue(null)

    const result = await fn("repo-other", "user-1")

    expect(result).toEqual({
      analysisId: "",
      status: "error",
      error: REPOSITORY_NOT_FOUND_ERROR,
    })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it.each([
    ["repo_summary", enqueueRepoSummary],
    ["asset_extraction", enqueueAssetExtraction],
  ])("never enqueues against another user's repository (%s)", async (_type, fn) => {
    // repo-1 belongs to the session user; the caller tries repo-owned-by-bob.
    mocks.repoFindFirst.mockImplementation(async (args: { where: { id: string; userId: string } }) => {
      // Only the owner's pair resolves — simulating the scoped findFirst.
      if (args.where.id === "repo-1" && args.where.userId === "bob") {
        return { id: "repo-1", owner: "bob", name: "hello", fullName: "bob/hello" }
      }
      return null
    })

    const result = await fn("repo-1", "alice")

    expect(result.status).toBe("error")
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe("enqueueRepoSummary", () => {
  it("queues a new pending analysis when none exists", async () => {
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const result = await enqueueRepoSummary("repo-1", "user-1")

    expect(result).toEqual({ analysisId: "new-analysis", status: "queued" })
    expect(mocks.repoFindFirst).toHaveBeenCalledWith({
      where: { id: "repo-1", userId: "user-1" },
      select: { id: true, owner: true, name: true, fullName: true },
    })
    expect(mocks.findFirst).toHaveBeenCalledTimes(2)
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        analysisType: "repo_summary",
        status: "pending",
        repositoryId: "repo-1",
        userId: "user-1",
      },
    })
  })

  it("returns already_completed when a completed summary exists and never creates", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "completed-1" })

    const result = await enqueueRepoSummary("repo-1", "user-1")

    expect(result).toEqual({ analysisId: "completed-1", status: "already_completed" })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("returns already_queued while a pending or running record is in flight", async () => {
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "queued-1", status: "pending" })
    expect(await enqueueRepoSummary("repo-1", "user-1")).toEqual({
      analysisId: "queued-1",
      status: "already_queued",
    })

    mocks.findFirst.mockReset()
    mocks.repoFindFirst.mockResolvedValue(ownedRepo)
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "queued-2", status: "running" })
    expect(await enqueueRepoSummary("repo-1", "user-1")).toEqual({
      analysisId: "queued-2",
      status: "already_queued",
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })
})

describe("enqueueRepoSummary — concurrent enqueue race", () => {
  it("maps the unique-violation loser of a concurrent enqueue to already_queued of the winner", async () => {
    // Both pre-checks see nothing; the insert loses the race against the active
    // partial unique index. The re-query then finds the winner's pending row.
    mocks.findFirst
      .mockResolvedValueOnce(null) // completed check → none
      .mockResolvedValueOnce(null) // queued/pre-insert check → none
      .mockResolvedValueOnce({ id: "winner-analysis", status: "pending" }) // queued re-query after P2002
    mocks.create.mockRejectedValueOnce({ code: "P2002" })

    const result = await enqueueRepoSummary("repo-1", "user-1")

    expect(result).toEqual({ analysisId: "winner-analysis", status: "already_queued" })
  })

  it("rethrows non-unique create failures rather than silently dedoupling", async () => {
    mocks.findFirst.mockResolvedValue(null).mockResolvedValue(null)
    mocks.create.mockRejectedValue(new Error("db unavailable"))

    await expect(enqueueRepoSummary("repo-1", "user-1")).rejects.toThrow("db unavailable")
  })
})

describe("enqueueAssetExtraction", () => {
  it("queues only when nothing is pending or running", async () => {
    mocks.findFirst.mockResolvedValueOnce(null)

    const result = await enqueueAssetExtraction("repo-1", "user-1")

    expect(result).toEqual({ analysisId: "new-analysis", status: "queued" })
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        analysisType: "asset_extraction",
        status: "pending",
        input: { maxFiles: 20, useLLM: true },
        repositoryId: "repo-1",
        userId: "user-1",
      },
    })
  })

  it("deduplicates against any in-flight extraction regardless of completion state", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "queued-extract", status: "running" })

    expect(await enqueueAssetExtraction("repo-1", "user-1")).toEqual({
      analysisId: "queued-extract",
      status: "already_queued",
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("maps a concurrent unique-violation to already_queued of the winner", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(null) // asset_extraction queued check → none
      .mockResolvedValueOnce({ id: "winner-extract", status: "pending" }) // re-query after P2002
    mocks.create.mockRejectedValueOnce({ code: "P2002" })

    expect(await enqueueAssetExtraction("repo-1", "user-1")).toEqual({
      analysisId: "winner-extract",
      status: "already_queued",
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })
})