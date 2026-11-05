import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Direct repo_summary server actions (analyze/retry) — Agent D ──
// Verifies the best-effort repo_classification enqueue trigger after a fresh
// summary: fires only for non-cached summaries, never turns a successful
// summary into a failure, and never recurses into another summary.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  repoFindFirst: vi.fn(), // getRepoMeta + enqueue ownership gate
  analysisFindFirst: vi.fn(), // getRepoAnalysisStatus + enqueue active-dedup
  analysisCreate: vi.fn(),
  fetchRepoReadme: vi.fn(),
  analyzeRepoSummary: vi.fn(),
  retryFailedAnalysis: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findFirst: mocks.repoFindFirst },
    analysis: { findFirst: mocks.analysisFindFirst, create: mocks.analysisCreate },
  },
}))
vi.mock("@/services/github", () => ({ fetchRepoReadme: mocks.fetchRepoReadme }))
vi.mock("@/services/llm", () => ({
  analyzeRepoSummary: mocks.analyzeRepoSummary,
  retryFailedAnalysis: mocks.retryFailedAnalysis,
  getRepoAnalysisStatus: async (repoId: string, userId: string) => ({
    status: "completed",
    summary: { oneLine: "fresh" },
    cachedAt: new Date().toISOString(),
    model: "gpt",
    tokensUsed: 0,
    durationMs: 100,
    error: null,
    repoId,
    userId,
  }),
  AnalysisError: class AnalysisError extends Error {
    code = "UNKNOWN"
  },
}))

import { analyzeRepositoryAction, retryAnalysisAction } from "@/actions/analysis"

const repoMeta = {
  id: "repo-1",
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
}

const summary = {
  oneLine: "A great repo",
  problem: "x",
  techStack: ["ts"],
  scenarios: ["s"],
  highlights: ["h"],
  learningValue: "v",
  reuseSuggestion: "r",
  simpleExplanation: "e",
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
  mocks.repoFindFirst.mockResolvedValue(repoMeta)
  mocks.analysisFindFirst.mockImplementation(async (args: { where?: { analysisType?: string } }) => {
    if (args.where?.analysisType === "repo_summary") {
      return { status: "completed", result: { summary }, error: null }
    }
    return null // repo_classification active-dedup -> none
  })
  mocks.analysisCreate.mockResolvedValue({ id: "classification-1" })
  mocks.fetchRepoReadme.mockResolvedValue("# Hello")
  mocks.analyzeRepoSummary.mockResolvedValue({ summary, cached: false })
  mocks.retryFailedAnalysis.mockResolvedValue({ summary, cached: false })
})

describe("analyzeRepositoryAction triggers classification", () => {
  it("enqueues repo_classification after a fresh summary and still returns the summary", async () => {
    const result = await analyzeRepositoryAction("repo-1")

    expect(result.error).toBeNull()
    expect(result.summary).toEqual(summary)
    expect(mocks.analysisCreate).toHaveBeenCalledTimes(1)
    expect(mocks.analysisCreate).toHaveBeenCalledWith({
      data: {
        analysisType: "repo_classification",
        status: "pending",
        input: { mode: "all", force: false },
        repositoryId: "repo-1",
        userId: "user-1",
      },
    })
  })

  it("does not enqueue when the summary is served from cache (content unchanged)", async () => {
    mocks.analyzeRepoSummary.mockResolvedValue({ summary, cached: true })

    const result = await analyzeRepositoryAction("repo-1")

    expect(result.error).toBeNull()
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })

  it("never turns a successful summary into a failure when the enqueue throws", async () => {
    mocks.analysisCreate.mockRejectedValueOnce(new Error("db unavailable")) // inside enqueue

    const result = await analyzeRepositoryAction("repo-1")

    expect(result.error).toBeNull()
    expect(result.summary).toEqual(summary)
    expect(mocks.analysisCreate).toHaveBeenCalledTimes(1) // one failed enqueue attempt
  })

  it("enqueues at most one classification job (no recursive loop)", async () => {
    mocks.analyzeRepoSummary.mockResolvedValue({ summary, cached: false })

    await analyzeRepositoryAction("repo-1")

    const classificationCreates = mocks.analysisCreate.mock.calls.filter(
      (c) => (c[0] as { data?: { analysisType?: string } }).data?.analysisType === "repo_classification",
    )
    expect(classificationCreates).toHaveLength(1)
  })
})

describe("retryAnalysisAction triggers classification", () => {
  it("enqueues repo_classification after a successful retry", async () => {
    const result = await retryAnalysisAction("repo-1")

    expect(result.error).toBeNull()
    expect(result.summary).toEqual(summary)
    expect(mocks.analysisCreate).toHaveBeenCalledWith({
      data: {
        analysisType: "repo_classification",
        status: "pending",
        input: { mode: "all", force: false },
        repositoryId: "repo-1",
        userId: "user-1",
      },
    })
  })

  it("does not enqueue for a cached retry result", async () => {
    mocks.retryFailedAnalysis.mockResolvedValue({ summary, cached: true })

    const result = await retryAnalysisAction("repo-1")

    expect(result.error).toBeNull()
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })

  it("propagates a genuine analysis failure without touching the queue", async () => {
    mocks.retryFailedAnalysis.mockRejectedValue(
      Object.assign(new Error("LLM quota exceeded"), { code: "UNKNOWN" }),
    )

    const result = await retryAnalysisAction("repo-1")

    expect(result.error).toBe("LLM quota exceeded")
    expect(result.summary).toBeNull()
    expect(mocks.analysisCreate).not.toHaveBeenCalled()
  })
})