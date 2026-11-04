import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ── LLM + DB fully mocked; no real OpenAI or PostgreSQL access ──

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  generateRepoEmbedding: vi.fn(),
  completeAnalysis: vi.fn(),
}))

vi.mock("@/lib/openai", () => ({
  openai: { chat: { completions: { create: mocks.openaiCreate } } },
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    analysis: {
      findFirst: mocks.findFirst,
      update: mocks.update,
      create: mocks.create,
      deleteMany: mocks.deleteMany,
    },
  },
}))
vi.mock("@/services/llm/repo-embedding.service", () => ({
  generateRepoEmbedding: mocks.generateRepoEmbedding,
}))
vi.mock("@/services/analysis/leasing.service", () => ({
  completeAnalysis: mocks.completeAnalysis,
}))

import {
  analyzeRepoSummary,
  retryFailedAnalysis,
  getRepoAnalysisStatus,
  analyzeCodePatterns,
  AnalysisError,
  type RepoSummary,
} from "@/services/llm/analysis.service"

const repoMeta = {
  name: "hello-world",
  fullName: "octocat/hello-world",
  description: "A demo repository",
  language: "TypeScript",
  topics: ["api", "demo"],
  stars: 50,
  forks: 4,
  url: "https://github.com/octocat/hello-world",
  defaultBranch: "main",
}

const summary: RepoSummary = {
  oneLine: "A sample repo",
  problem: "Solves duplication",
  techStack: ["TypeScript"],
  scenarios: ["Learning"],
  highlights: ["Clean"],
  learningValue: "Patterns",
  reuseSuggestion: "Reuse the layout",
  simpleExplanation: "A small demo.",
}

const summaryJson = JSON.stringify(summary)

const savedKey = process.env.OPENAI_API_KEY

const workerOpts = { analysisId: "analysis-w", workerId: "worker-1" }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENAI_API_KEY = "sk-test-not-real"
  mocks.update.mockResolvedValue({})
  mocks.generateRepoEmbedding.mockResolvedValue(true)
  mocks.completeAnalysis.mockResolvedValue(true)
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = savedKey
})

describe("analyzeRepoSummary — direct path", () => {
  it("creates a running record, calls the LLM and completes with the parsed summary", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: "analysis-1" })
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: summaryJson } }],
    })

    const result = await analyzeRepoSummary("repo-1", "user-1", repoMeta, "# Hello")

    expect(result.cached).toBe(false)
    expect(result.summary).toEqual(summary)
    expect(mocks.openaiCreate).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "analysis-1" },
      data: expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ summary }),
      }),
    })
    // embedding is best-effort, fired after completion
    expect(mocks.generateRepoEmbedding).toHaveBeenCalledWith("repo-1", "user-1")
  })

  it("returns the cached summary without calling the LLM or creating a record", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "analysis-cached",
      result: { summary },
    })

    const result = await analyzeRepoSummary("repo-1", "user-1", repoMeta, "# Hello")

    expect(result.cached).toBe(true)
    expect(result.summary).toEqual(summary)
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("throws API_KEY_MISSING before creating a record when the key is unset and no cache exists", async () => {
    delete process.env.OPENAI_API_KEY
    mocks.findFirst.mockResolvedValue(null)

    await expect(analyzeRepoSummary("repo-1", "user-1", repoMeta, null)).rejects.toMatchObject({
      code: "API_KEY_MISSING",
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
  })

  it("maps invalid LLM JSON to LLM_JSON_PARSE_FAILED and marks the record failed", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: "analysis-2" })
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: "certainly not json" } }],
    })

    await expect(analyzeRepoSummary("repo-1", "user-1", repoMeta, null)).rejects.toMatchObject({
      code: "LLM_JSON_PARSE_FAILED",
    })
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "analysis-2" },
      data: expect.objectContaining({ status: "failed" }),
    })
  })

  it("maps an invalid-key LLM error to API_KEY_MISSING and persists the user error", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: "analysis-3" })
    mocks.openaiCreate.mockRejectedValue(new Error("Incorrect API key provided"))

    await expect(analyzeRepoSummary("repo-1", "user-1", repoMeta, null)).rejects.toMatchObject({
      code: "API_KEY_MISSING",
    })
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "analysis-3" },
      data: expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("API key is invalid or missing"),
      }),
    })
  })

  it("strips markdown code fences before parsing", async () => {
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: "analysis-4" })
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: `\`\`\`json\n${summaryJson}\n\`\`\`` } }],
    })

    const result = await analyzeRepoSummary("repo-1", "user-1", repoMeta, null)
    expect(result.summary.oneLine).toBe("A sample repo")
  })
})

describe("analyzeRepoSummary — worker path (analysisId)", () => {
  it("requires a worker identity", async () => {
    await expect(
      analyzeRepoSummary("repo-1", "user-1", repoMeta, null, { analysisId: "analysis-w" }),
    ).rejects.toMatchObject({ code: "UNKNOWN" })
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
    expect(mocks.completeAnalysis).not.toHaveBeenCalled()
  })

  it("persists via completeAnalysis only while the worker still owns the lease", async () => {
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: summaryJson } }],
    })

    const result = await analyzeRepoSummary("repo-1", "user-1", repoMeta, "# Hello", workerOpts)

    expect(result.cached).toBe(false)
    expect(mocks.completeAnalysis).toHaveBeenCalledWith({
      analysisId: "analysis-w",
      workerId: "worker-1",
      status: "completed",
      result: expect.objectContaining({ summary }),
      model: expect.any(String),
    })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.generateRepoEmbedding).toHaveBeenCalledWith("repo-1", "user-1")
  })

  it("classifies invalid JSON like the direct path and never completes the claim", async () => {
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: "not json at all" } }],
    })

    await expect(
      analyzeRepoSummary("repo-1", "user-1", repoMeta, null, workerOpts),
    ).rejects.toMatchObject({ code: "LLM_JSON_PARSE_FAILED" })
    expect(mocks.completeAnalysis).not.toHaveBeenCalled()
    expect(mocks.generateRepoEmbedding).not.toHaveBeenCalled()
  })

  it("returns the summary but skips embedding when the lease was lost", async () => {
    mocks.completeAnalysis.mockResolvedValue(false)
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: summaryJson } }],
    })

    const result = await analyzeRepoSummary("repo-1", "user-1", repoMeta, "# Hello", workerOpts)

    expect(result.cached).toBe(false)
    expect(mocks.completeAnalysis).toHaveBeenCalledTimes(1)
    expect(mocks.generateRepoEmbedding).not.toHaveBeenCalled()
  })
})

describe("retryFailedAnalysis", () => {
  it("deletes the failed record and produces a fresh summary", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ status: "failed" })
      .mockResolvedValueOnce(null)
    mocks.deleteMany.mockResolvedValue({ count: 1 })
    mocks.create.mockResolvedValue({ id: "analysis-retry" })
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: summaryJson } }],
    })

    const result = await retryFailedAnalysis("repo-1", "user-1", repoMeta, null)

    expect(result.summary.oneLine).toBe("A sample repo")
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        repositoryId: "repo-1",
        userId: "user-1",
        analysisType: "repo_summary",
        status: "failed",
      },
    })
  })

  it("refuses to retry when the latest analysis is not failed", async () => {
    mocks.findFirst.mockResolvedValue({ status: "completed" })

    await expect(retryFailedAnalysis("repo-1", "user-1", repoMeta, null)).rejects.toBeInstanceOf(
      AnalysisError,
    )
    expect(mocks.deleteMany).not.toHaveBeenCalled()
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
  })
})

describe("getRepoAnalysisStatus", () => {
  it("reports not_generated when no analysis exists", async () => {
    mocks.findFirst.mockResolvedValue(null)
    expect(await getRepoAnalysisStatus("repo-1", "user-1")).toEqual({
      status: "not_generated",
      summary: null,
      cachedAt: null,
      model: null,
      error: null,
    })
  })

  it("reports completed status with the cached summary and model", async () => {
    mocks.findFirst.mockResolvedValue({
      status: "completed",
      result: { summary },
      error: null,
      model: "gpt-4o-mini",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    })
    const meta = await getRepoAnalysisStatus("repo-1", "user-1")

    expect(meta.status).toBe("completed")
    expect(meta.summary).toEqual(summary)
    expect(meta.cachedAt).toBe("2026-01-02T00:00:00.000Z")
    expect(meta.model).toBe("gpt-4o-mini")
  })

  it("surfaces the error of a failed analysis", async () => {
    mocks.findFirst.mockResolvedValue({
      status: "failed",
      result: null,
      error: "LLM call failed. Please try again.",
      model: null,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    })
    const meta = await getRepoAnalysisStatus("repo-1", "user-1")

    expect(meta.status).toBe("failed")
    expect(meta.summary).toBeNull()
    expect(meta.error).toBe("LLM call failed. Please try again.")
  })
})

describe("analyzeCodePatterns", () => {
  it("returns a fallback result without calling the LLM when the API key is missing", async () => {
    delete process.env.OPENAI_API_KEY

    const raw = await analyzeCodePatterns({
      userId: "user-1",
      repositoryId: "repo-1",
      content: "export const x = 1",
      fileName: "worker.ts",
      language: "TypeScript",
    })

    expect(mocks.openaiCreate).not.toHaveBeenCalled()
    expect(JSON.parse(raw).patternName).toBe("worker.ts")
    expect(JSON.parse(raw).whatItDoes).toContain("LLM parse failed")
  })
})