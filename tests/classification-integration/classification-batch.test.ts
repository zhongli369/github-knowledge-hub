import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Classification batch/progress server actions (Agent D) ──
// auth + prisma fully mocked; verifies mode whitelist, per-user scoping,
// duplicate-enqueue protection, and serializable progress aggregation.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  repoFindMany: vi.fn(),
  repoFindFirst: vi.fn(), // enqueue ownership gate
  rcFindMany: vi.fn(),
  rcFindUnique: vi.fn(),
  analysisCount: vi.fn(),
  analysisFindMany: vi.fn(),
  analysisFindFirst: vi.fn(), // active dedup
  analysisCreate: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findMany: mocks.repoFindMany, findFirst: mocks.repoFindFirst },
    repositoryClassification: { findMany: mocks.rcFindMany, findUnique: mocks.rcFindUnique },
    analysis: {
      count: mocks.analysisCount,
      findMany: mocks.analysisFindMany,
      findFirst: mocks.analysisFindFirst,
      create: mocks.analysisCreate,
    },
  },
}))

import {
  startClassificationBatch,
  getClassificationProgress,
} from "@/actions/classification"

const ownedRepo = { id: "r1", owner: "alice", name: "a", fullName: "alice/a" }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
  mocks.repoFindFirst.mockResolvedValue(ownedRepo)
  mocks.analysisFindFirst.mockResolvedValue(null)
  mocks.analysisCreate.mockImplementation(async (args: unknown) => {
    const data = (args as { data?: { repositoryId?: string; analysisType?: string } }).data
    return { id: `job:${data?.repositoryId}`, ...data }
  })
})

describe("startClassificationBatch", () => {
  it("enqueues every repository in mode=all with force=false", async () => {
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }])

    const result = await startClassificationBatch("all")

    expect(result).toEqual({ enqueued: 2, skipped: 0, total: 2 })
    expect(mocks.analysisCreate).toHaveBeenCalledTimes(2)
    expect(mocks.analysisCreate).toHaveBeenNthCalledWith(1, {
      data: {
        analysisType: "repo_classification",
        status: "pending",
        input: { mode: "all", force: false, batchId: expect.any(String) },
        repositoryId: "r1",
        userId: "user-1",
      },
    })
    expect(mocks.analysisCreate).toHaveBeenNthCalledWith(2, {
      data: {
        analysisType: "repo_classification",
        status: "pending",
        input: { mode: "all", force: false, batchId: expect.any(String) },
        repositoryId: "r2",
        userId: "user-1",
      },
    })
  })

  it("only enqueues unclassified repositories in mode=unclassified", async () => {
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }])
    mocks.rcFindMany.mockResolvedValue([{ repositoryId: "r1", status: "classified" }])

    const result = await startClassificationBatch("unclassified")

    expect(result).toEqual({ enqueued: 2, skipped: 0, total: 2 })
    expect(mocks.analysisCreate).toHaveBeenCalledTimes(2)
    const calledRepoIds = mocks.analysisCreate.mock.calls.map(
      (c) => (c[0] as { data?: { repositoryId?: string } }).data?.repositoryId,
    )
    expect(calledRepoIds).toEqual(["r2", "r3"])
  })

  it("re-queues previously-failed repositories in mode=unclassified (retry)", async () => {
    // A repo whose last classification failed (status="failed") must be queued
    // again by a retry batch; only "classified" rows are excluded.
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }, { id: "r2" }])
    // Mimic Prisma's `where.status === "classified"` filter.
    mocks.rcFindMany.mockImplementation(async (args: { where?: { status?: string; repositoryId?: { in?: string[] } } }) =>
      [
        { repositoryId: "r1", status: "failed" },
        { repositoryId: "r2", status: "classified" },
      ].filter(
        (r) =>
          r.status === args.where?.status &&
          (args.where?.repositoryId?.in?.includes(r.repositoryId) ?? true),
      ),
    )

    const result = await startClassificationBatch("unclassified")

    expect(result).toEqual({ enqueued: 1, skipped: 0, total: 1 })
    const calledRepoIds = mocks.analysisCreate.mock.calls.map(
      (c) => (c[0] as { data?: { repositoryId?: string } }).data?.repositoryId,
    )
    expect(calledRepoIds).toEqual(["r1"])
  })

  it("marks already-classified repos as skipped when the pre-filter lets them through", async () => {
    // Contrived: pre-filter sees no classified rows, but the enqueue re-check does.
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }])
    mocks.rcFindMany.mockResolvedValue([])
    mocks.rcFindUnique.mockResolvedValue({ status: "classified" })

    const result = await startClassificationBatch("unclassified")

    expect(result).toEqual({ enqueued: 0, skipped: 1, total: 1 })
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })

  it("forces reclassification in mode=reclassify", async () => {
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }])

    const result = await startClassificationBatch("reclassify")

    expect(result).toEqual({ enqueued: 1, skipped: 0, total: 1 })
    expect(mocks.analysisCreate).toHaveBeenCalledWith({
      data: {
        analysisType: "repo_classification",
        status: "pending",
        input: { mode: "reclassify", force: true, batchId: expect.any(String) },
        repositoryId: "r1",
        userId: "user-1",
      },
    })
  })

  it("prevents duplicate pending jobs: an in-flight job counts as skipped", async () => {
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }])
    mocks.analysisFindFirst.mockResolvedValue({ id: "active-1", status: "pending" })

    const result = await startClassificationBatch("all")

    expect(result).toEqual({ enqueued: 0, skipped: 1, total: 1 })
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })

  it("rejects an unknown mode", async () => {
    await expect(startClassificationBatch("overflow" as never)).rejects.toThrow(
      "Invalid classification mode",
    )
    expect(mocks.repoFindMany).not.toHaveBeenCalled()
  })

  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue({ user: undefined })

    await expect(startClassificationBatch("all")).rejects.toThrow("Not authenticated")
    expect(mocks.repoFindMany).not.toHaveBeenCalled()
  })

  it("scopes every query to the session user id", async () => {
    mocks.repoFindMany.mockResolvedValue([{ id: "r1" }])

    await startClassificationBatch("all")

    expect(mocks.repoFindMany).toHaveBeenCalledWith({ where: { userId: "user-1" }, select: { id: true } })
    expect(mocks.analysisCreate.mock.calls[0][0]).toMatchObject({
      data: { userId: "user-1" },
    })
  })
})

describe("getClassificationProgress", () => {
  it("returns serializable per-user job counts and aggregates outcomes", async () => {
    mocks.analysisCount.mockImplementation(async (args: { where?: { status?: string } }) => {
      switch (args.where?.status) {
        case "pending":
          return 1
        case "running":
          return 2
        case "completed":
          return 3
        case "failed":
          return 1
        default:
          return 7
      }
    })
    // Most recent completed job per repository wins:
    //  r1 newest = classified (older skipped ignored), r2 newest = skipped.
    mocks.analysisFindMany.mockResolvedValue([
      { repositoryId: "r1", result: { status: "classified", categorySlugs: ["backend"] } },
      { repositoryId: "r1", result: { status: "skipped", fromCache: true } },
      { repositoryId: "r2", result: { status: "unclassified" } },
    ])

    const progress = await getClassificationProgress()

    expect(progress).toEqual({
      total: 7,
      pending: 1,
      running: 2,
      completed: 3,
      failed: 1,
      succeeded: 1, // r1 (newest classified)
      skipped: 1, // r2 (unclassified)
    })
  })

  it("scopes every query to the session user id", async () => {
    mocks.analysisCount.mockResolvedValue(0)
    mocks.analysisFindMany.mockResolvedValue([])

    await getClassificationProgress()

    const countCalls = mocks.analysisCount.mock.calls.map((c) => c[0])
    expect(countCalls[0]).toEqual({ where: { userId: "user-1", analysisType: "repo_classification" } })
    for (const call of countCalls) {
      expect(call.where.userId).toBe("user-1")
    }
    expect(mocks.analysisFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", analysisType: "repo_classification", status: "completed" },
      }),
    )
  })

  it("limits progress to the newest batch instead of accumulating historical reruns", async () => {
    mocks.analysisFindMany.mockImplementation(async (args: {
      select?: { input?: boolean; result?: boolean }
    }) => {
      if (args.select?.input) {
        return [{ input: { batchId: "batch-new" } }, { input: { batchId: "batch-old" } }]
      }
      return [{ repositoryId: "r1", result: { status: "classified" } }]
    })
    mocks.analysisCount.mockImplementation(async (args: { where?: { status?: string } }) =>
      args.where?.status === "completed" ? 1 : 0,
    )

    const progress = await getClassificationProgress()

    expect(progress).toMatchObject({ completed: 1, succeeded: 1, skipped: 0 })
    for (const call of mocks.analysisCount.mock.calls) {
      expect(call[0].where.input).toEqual({ path: ["batchId"], equals: "batch-new" })
    }
    expect(mocks.analysisFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          input: { path: ["batchId"], equals: "batch-new" },
          status: "completed",
        }),
      }),
    )
  })

  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue({ user: undefined })

    await expect(getClassificationProgress()).rejects.toThrow("Not authenticated")
    expect(mocks.analysisCount).not.toHaveBeenCalled()
  })
})