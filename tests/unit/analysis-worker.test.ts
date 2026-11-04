import { beforeEach, describe, expect, it, vi } from "vitest"

const leasingMocks = vi.hoisted(() => ({
  claimNextAnalysis: vi.fn(),
  completeAnalysis: vi.fn(),
  failAnalysis: vi.fn(),
  renewLease: vi.fn(),
  createWorkerId: vi.fn(() => "unit-test-worker"),
  HEARTBEAT_INTERVAL_MS: 1_000,
}))

const githubMocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  disconnect: vi.fn(),
  analyze: vi.fn(),
  extract: vi.fn(),
  createOctokit: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findUnique: githubMocks.findUnique },
    $disconnect: githubMocks.disconnect,
  },
}))
vi.mock("@/services/llm/analysis.service", () => ({
  analyzeRepoSummary: githubMocks.analyze,
  AnalysisError: class AnalysisError extends Error {
    code = "LLM_CALL_FAILED"
    durationMs?: number
  },
}))
vi.mock("@/services/knowledge/extraction.service", () => ({ extractAssetsFromRepo: githubMocks.extract }))
vi.mock("@/lib/github/client", () => ({ createOctokit: githubMocks.createOctokit }))
vi.mock("@/services/analysis/leasing.service", () => leasingMocks)

import { processOne } from "../../workers/analysis-worker"

function claimed(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "analysis-1",
    analysisType: "asset_extraction",
    repositoryId: "repo-1",
    userId: "user-1",
    input: null,
    attempts: 1,
    workerId: "unit-test-worker",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  leasingMocks.claimNextAnalysis.mockResolvedValue(null)
  leasingMocks.completeAnalysis.mockResolvedValue(true)
  leasingMocks.failAnalysis.mockResolvedValue(true)
  leasingMocks.renewLease.mockResolvedValue(true)
})

describe("analysis worker processOne", () => {
  it("does nothing when no analysis is claimable", async () => {
    expect(await processOne()).toBe(false)
    expect(leasingMocks.completeAnalysis).not.toHaveBeenCalled()
    expect(leasingMocks.failAnalysis).not.toHaveBeenCalled()
  })

  it("fails a repo summary without repositoryId without calling external services", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(
      claimed({ id: "analysis-missing-repo", analysisType: "repo_summary", repositoryId: null }),
    )
    expect(await processOne()).toBe(true)
    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-missing-repo",
        workerId: "unit-test-worker",
        error: "Missing repositoryId for repo_summary analysis",
      }),
    )
    expect(githubMocks.analyze).not.toHaveBeenCalled()
    expect(githubMocks.createOctokit).not.toHaveBeenCalled()
    expect(leasingMocks.completeAnalysis).not.toHaveBeenCalled()
  })

  it("marks unsupported analysis types as failed", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(
      claimed({ id: "analysis-unknown", analysisType: "unknown" }),
    )
    expect(await processOne()).toBe(true)
    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ analysisId: "analysis-unknown", error: "Unsupported analysis type: unknown" }),
    )
  })

  it("completes asset extraction with mocked extraction and no real credentials", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(
      claimed({ id: "analysis-assets", input: { maxFiles: 2, useLLM: false } }),
    )
    githubMocks.findUnique.mockResolvedValue({ owner: "owner", name: "repo" })
    githubMocks.extract.mockResolvedValue({ extracted: 1, skipped: 2 })

    expect(await processOne()).toBe(true)
    expect(githubMocks.extract).toHaveBeenCalledWith("user-1", "repo-1", "owner", "repo", {
      maxFiles: 2,
      useLLM: false,
    })
    expect(leasingMocks.completeAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-assets",
        workerId: "unit-test-worker",
        status: "completed",
        result: { extracted: 1, skipped: 2 },
      }),
    )
    expect(leasingMocks.failAnalysis).not.toHaveBeenCalled()
  })

  it("does not persist results after losing the lease but still releases the worker slot", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(
      claimed({ id: "analysis-stale", input: {} }),
    )
    githubMocks.findUnique.mockResolvedValue({ owner: "owner", name: "repo" })
    githubMocks.extract.mockResolvedValue({ extracted: 1, skipped: 2 })
    leasingMocks.completeAnalysis.mockResolvedValue(false)

    expect(await processOne()).toBe(true)
    expect(leasingMocks.completeAnalysis).toHaveBeenCalled()
    expect(leasingMocks.failAnalysis).not.toHaveBeenCalled()

    leasingMocks.claimNextAnalysis.mockResolvedValue(null)
    expect(await processOne()).toBe(false)
  })

  it("records processing errors as failed and releases the worker slot", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed({ id: "analysis-error", input: {} }))
    githubMocks.findUnique.mockResolvedValue({ owner: "owner", name: "repo" })
    githubMocks.extract.mockRejectedValue(new Error("synthetic failure"))

    expect(await processOne()).toBe(true)
    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ analysisId: "analysis-error", error: "synthetic failure" }),
    )
  })

  it("delegates repo summary completion after a valid client finds no README", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(
      claimed({ id: "analysis-summary", analysisType: "repo_summary" }),
    )
    githubMocks.findUnique.mockResolvedValue({
      name: "repo", fullName: "owner/repo", description: null, language: "TypeScript",
      topics: [], stars: 0, forks: 0, url: "https://example.invalid", defaultBranch: "main", owner: "owner",
    })
    githubMocks.createOctokit.mockResolvedValue({
      repos: { getReadme: vi.fn().mockRejectedValue(new Error("Not Found")) },
    })
    githubMocks.analyze.mockResolvedValue({ summary: { oneLine: "x" }, cached: false })

    expect(await processOne()).toBe(true)
    expect(githubMocks.analyze).toHaveBeenCalledWith(
      "repo-1",
      "user-1",
      expect.objectContaining({ fullName: "owner/repo" }),
      null,
      { analysisId: "analysis-summary", workerId: "unit-test-worker" },
    )
  })

  it("fails the claimed task when the GitHub token cannot be decrypted", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(
      claimed({ id: "analysis-token-error", analysisType: "repo_summary" }),
    )
    githubMocks.findUnique.mockResolvedValue({
      name: "repo", fullName: "owner/repo", description: null, language: "TypeScript",
      topics: [], stars: 0, forks: 0, url: "https://example.invalid", defaultBranch: "main", owner: "owner",
    })
    githubMocks.createOctokit.mockRejectedValue(new Error("Failed to decrypt the stored GitHub token"))

    expect(await processOne()).toBe(true)
    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-token-error",
        error: "Failed to decrypt the stored GitHub token",
      }),
    )
    expect(githubMocks.analyze).not.toHaveBeenCalled()
  })
})