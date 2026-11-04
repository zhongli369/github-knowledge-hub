import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Queue dedup logic with mocked Prisma; no real DB access ──

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    analysis: { findFirst: mocks.findFirst, create: mocks.create },
  },
}))

import { enqueueRepoSummary, enqueueAssetExtraction } from "@/services/intake"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockImplementation(async (args: unknown) => ({
    id: "new-analysis",
    ...(args as { data?: { analysisType?: string } }).data,
  }))
})

describe("enqueueRepoSummary", () => {
  it("queues a new pending analysis when none exists", async () => {
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    const result = await enqueueRepoSummary("repo-1", "user-1")

    expect(result).toEqual({ analysisId: "new-analysis", status: "queued" })
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
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "queued-2", status: "running" })
    expect(await enqueueRepoSummary("repo-1", "user-1")).toEqual({
      analysisId: "queued-2",
      status: "already_queued",
    })
    expect(mocks.create).not.toHaveBeenCalled()
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
})