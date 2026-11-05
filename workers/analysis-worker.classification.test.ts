import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ── Worker handlers for analysisType="repo_classification" (Agent D) ──
// All dependencies mocked (classifier, LLM, GitHub, DB) — no paid LLM calls.

const leasingMocks = vi.hoisted(() => ({
  claimNextAnalysis: vi.fn(),
  completeAnalysis: vi.fn(),
  failAnalysis: vi.fn(),
  renewLease: vi.fn(),
  createWorkerId: vi.fn(() => "class-test-worker"),
  HEARTBEAT_INTERVAL_MS: 1_000,
}))

const prismaMocks = vi.hoisted(() => ({
  findUnique: vi.fn(), // repository.findUnique
  repoFindFirst: vi.fn(), // repository.findFirst (enqueue ownership)
  analysisFindFirst: vi.fn(),
  analysisCreate: vi.fn(),
  disconnect: vi.fn(),
}))

const githubMocks = vi.hoisted(() => ({
  analyze: vi.fn(), // analyzeRepoSummary
  extract: vi.fn(), // extractAssetsFromRepo
  createOctokit: vi.fn(),
}))

const classifyMocks = vi.hoisted(() => ({
  classifyRepository: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findUnique: prismaMocks.findUnique, findFirst: prismaMocks.repoFindFirst },
    analysis: { findFirst: prismaMocks.analysisFindFirst, create: prismaMocks.analysisCreate },
    $disconnect: prismaMocks.disconnect,
  },
}))
vi.mock("@/lib/classification", () => ({ classifyRepository: classifyMocks.classifyRepository }))
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

import { flushActive, processOne, runClaimed } from "./analysis-worker"

function claimed(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "analysis-1",
    analysisType: "repo_classification",
    repositoryId: "repo-1",
    userId: "user-1",
    input: { mode: "all", force: false },
    attempts: 1,
    workerId: "class-test-worker",
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
  prismaMocks.analysisCreate.mockResolvedValue({ id: "classification-1" })
  prismaMocks.analysisFindFirst.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.WORKER_TASK_TIMEOUT_MS
})

describe("repo_classification handler", () => {
  it("delegates to the classification library and completes with the outcome", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed())
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-1" })
    classifyMocks.classifyRepository.mockResolvedValue({
      status: "classified",
      categorySlugs: ["backend", "api"],
      fromCache: false,
    })

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(classifyMocks.classifyRepository).toHaveBeenCalledWith({
      userId: "user-1",
      repositoryId: "repo-1",
      force: false,
    })
    expect(leasingMocks.completeAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-1",
        workerId: "class-test-worker",
        status: "completed",
        result: {
          status: "classified",
          categorySlugs: ["backend", "api"],
          fromCache: false,
          error: null,
        },
        fencingToken: 1,
      }),
    )
    expect(leasingMocks.failAnalysis).not.toHaveBeenCalled()
  })

  it("passes force=true through to the classification library", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed({ input: { mode: "reclassify", force: true } }))
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-1" })
    classifyMocks.classifyRepository.mockResolvedValue({
      status: "classified",
      categorySlugs: [],
      fromCache: false,
    })

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(classifyMocks.classifyRepository).toHaveBeenCalledWith({
      userId: "user-1",
      repositoryId: "repo-1",
      force: true,
    })
  })

  it("records an unchanged-hash skip without invoking extraction or LLM", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed())
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-1" })
    classifyMocks.classifyRepository.mockResolvedValue({
      status: "skipped",
      categorySlugs: ["frontend"],
      fromCache: true,
    })

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(leasingMocks.completeAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { status: "skipped", categorySlugs: ["frontend"], fromCache: true, error: null },
      }),
    )
    expect(githubMocks.extract).not.toHaveBeenCalled()
    expect(githubMocks.analyze).not.toHaveBeenCalled()
  })

  it("sends a classifyRepository status=failed through the bounded failure path", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed())
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-1" })
    classifyMocks.classifyRepository.mockResolvedValue({
      status: "failed",
      categorySlugs: [],
      fromCache: false,
      error: "LLM call failed",
    })

    expect(await processOne()).toBe(true)
    await flushActive()

    // A failed classification is NOT a completed job: it must reach the
    // failAnalysis retry path (released back to pending until attempts exhaust)
    // so the UI failed counter and re-queue semantics see it.
    expect(leasingMocks.completeAnalysis).not.toHaveBeenCalled()
    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-1",
        workerId: "class-test-worker",
        error: "LLM call failed",
        fencingToken: 1,
      }),
    )
  })

  it("falls back to the generic error when a failed outcome has no message", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed())
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-1" })
    classifyMocks.classifyRepository.mockResolvedValue({
      status: "failed",
      categorySlugs: [],
      fromCache: false,
    })

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(leasingMocks.completeAnalysis).not.toHaveBeenCalled()
    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Repository classification failed" }),
    )
  })

  it.each([
    ["classified", { status: "classified", categorySlugs: ["backend"], fromCache: false }],
    ["unclassified", { status: "unclassified", categorySlugs: [], fromCache: false }],
    ["skipped", { status: "skipped", categorySlugs: [], fromCache: true }],
  ])("completes a %s outcome as a successful job", async (_label, outcome) => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed())
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-1" })
    classifyMocks.classifyRepository.mockResolvedValue(outcome)

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(leasingMocks.completeAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-1",
        status: "completed",
        result: expect.objectContaining({ status: outcome.status }),
      }),
    )
    expect(leasingMocks.failAnalysis).not.toHaveBeenCalled()
  })

  it("fails a missing-repositoryId task without calling the classifier", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed({ repositoryId: null }))

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-1",
        error: "Missing repositoryId for repo_classification analysis",
      }),
    )
    expect(classifyMocks.classifyRepository).not.toHaveBeenCalled()
  })

  it("fails an ownership mismatch permanently without classifying", async () => {
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-b" })

    await runClaimed(claimed({ userId: "user-a" }))

    expect(classifyMocks.classifyRepository).not.toHaveBeenCalled()
    expect(leasingMocks.failAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: "analysis-1",
        error: expect.stringContaining("Ownership mismatch"),
        maxAttempts: 1,
      }),
    )
  })

  it("does not enqueue further tasks from a classification handler", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(claimed())
    prismaMocks.findUnique.mockResolvedValue({ userId: "user-1" })
    classifyMocks.classifyRepository.mockResolvedValue({ status: "skipped", categorySlugs: [], fromCache: true })

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(prismaMocks.analysisCreate).not.toHaveBeenCalled()
  })
})

describe("repo_summary success triggers on-demand classification (one-way)", () => {
  function summaryClaim() {
    return claimed({
      id: "analysis-summary",
      analysisType: "repo_summary",
    })
  }

  function repoMeta() {
    return {
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: "A demo repository",
      language: "TypeScript",
      topics: ["api"],
      stars: 50,
      forks: 4,
      url: "https://github.com/octocat/hello-world",
      defaultBranch: "main",
      owner: "octocat",
      userId: "user-1",
    }
  }

  it("enqueues a repo_classification task after a successful fresh summary", async () => {
    leasingMocks.claimNextAnalysis.mockResolvedValue(summaryClaim())
    prismaMocks.findUnique.mockResolvedValue(repoMeta())
    githubMocks.createOctokit.mockResolvedValue({
      repos: { getReadme: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })) },
    })
    githubMocks.analyze.mockResolvedValue({ summary: { oneLine: "x" }, cached: false })
    prismaMocks.repoFindFirst.mockResolvedValue({ id: "repo-1", owner: "octocat", name: "hello-world", fullName: "octocat/hello-world" })

    expect(await processOne()).toBe(true)
    await flushActive()

    expect(prismaMocks.analysisCreate).toHaveBeenCalledWith({
      data: {
        analysisType: "repo_classification",
        status: "pending",
        input: { mode: "all", force: false },
        repositoryId: "repo-1",
        userId: "user-1",
      },
    })
    // The summary task itself completed; no failure surfaced.
    expect(leasingMocks.failAnalysis).not.toHaveBeenCalled()
  })
})