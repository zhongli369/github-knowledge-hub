import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
  disconnect: vi.fn(),
  analyze: vi.fn(),
  extract: vi.fn(),
  createOctokit: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    analysis: { findFirst: mocks.findFirst, update: mocks.update },
    repository: { findUnique: mocks.findUnique },
    $disconnect: mocks.disconnect,
  },
}))
vi.mock("@/services/llm/analysis.service", () => ({ analyzeRepoSummary: mocks.analyze }))
vi.mock("@/services/knowledge/extraction.service", () => ({ extractAssetsFromRepo: mocks.extract }))
vi.mock("@/lib/github/client", () => ({ createOctokit: mocks.createOctokit }))

import { processOne } from "../../workers/analysis-worker"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockResolvedValue({})
})

describe("analysis worker processOne", () => {
  it("does nothing when no analysis is pending", async () => {
    mocks.findFirst.mockResolvedValue(null)
    expect(await processOne()).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("fails a repo summary without repositoryId without calling external services", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "analysis-missing-repo", analysisType: "repo_summary", repositoryId: null, userId: "user-1",
    })
    expect(await processOne()).toBe(true)
    expect(mocks.update).toHaveBeenNthCalledWith(1, {
      where: { id: "analysis-missing-repo" }, data: { status: "running" },
    })
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "analysis-missing-repo" },
      data: { status: "failed", error: "Missing repositoryId for repo_summary analysis" },
    })
    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.createOctokit).not.toHaveBeenCalled()
  })

  it("marks unsupported analysis types as failed", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "analysis-unknown", analysisType: "unknown", repositoryId: null, userId: "user-1",
    })
    expect(await processOne()).toBe(true)
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "analysis-unknown" },
      data: { status: "failed", error: "Unsupported analysis type: unknown" },
    })
  })

  it("completes asset extraction with mocked extraction and no real credentials", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "analysis-assets", analysisType: "asset_extraction", repositoryId: "repo-1", userId: "user-1",
      input: { maxFiles: 2, useLLM: false },
    })
    mocks.findUnique.mockResolvedValue({ owner: "owner", name: "repo" })
    const extractionResult = { extracted: 1, skipped: 2, assets: [] }
    mocks.extract.mockResolvedValue(extractionResult)

    expect(await processOne()).toBe(true)
    expect(mocks.extract).toHaveBeenCalledWith("user-1", "repo-1", "owner", "repo", {
      maxFiles: 2, useLLM: false,
    })
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "analysis-assets" },
      data: { status: "completed", result: extractionResult },
    })
  })

  it("records processing errors as failed and releases the worker slot", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "analysis-error", analysisType: "asset_extraction", repositoryId: "repo-1", userId: "user-1", input: {},
    })
    mocks.findUnique.mockResolvedValue({ owner: "owner", name: "repo" })
    mocks.extract.mockRejectedValue(new Error("synthetic failure"))

    expect(await processOne()).toBe(true)
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "analysis-error" }, data: { status: "failed", error: "synthetic failure" },
    })
    mocks.findFirst.mockResolvedValue(null)
    expect(await processOne()).toBe(false)
  })
})
