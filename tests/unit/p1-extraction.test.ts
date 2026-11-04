import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Extraction internals mocked; no real DB, GitHub or OpenAI access ──

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  repoFindFirst: vi.fn(),
  analyzeCodePatterns: vi.fn(),
  embedKnowledgeAsset: vi.fn(),
  fetchRepoFileTree: vi.fn(),
  fetchFileContent: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    knowledgeAsset: { create: mocks.create, findMany: mocks.findMany },
    repository: { findFirst: mocks.repoFindFirst },
  },
}))
vi.mock("@/services/llm/analysis.service", () => ({ analyzeCodePatterns: mocks.analyzeCodePatterns }))
vi.mock("@/services/llm/embeddings.service", () => ({ embedKnowledgeAsset: mocks.embedKnowledgeAsset }))
vi.mock("@/services/github", () => ({
  fetchRepoFileTree: mocks.fetchRepoFileTree,
  fetchFileContent: mocks.fetchFileContent,
}))

import {
  extractFromFile,
  extractWithLLM,
  extractAssetsFromRepo,
  parseCodeAnalysisResult,
  normalizeDifficulty,
} from "@/services/knowledge/extraction.service"

const SORTING_CONTENT =
  "function quickSort(list) {\n  if (list.length <= 1) return list;\n  const pivot = list[0];\n  const rest = list.slice(1);\n  return [...quickSort(rest.filter((x) => x < pivot)), pivot, ...quickSort(rest.filter((x) => x >= pivot))];\n}"

const SORTING_LANG_JSON = JSON.stringify({
  patternName: "QuickSort",
  whatItDoes: "Recursive divide and conquer sorting",
  reuseValue: "Use for stable sorting by a key",
  keyInsight: "Pick a median pivot",
  difficulty: "intermediate",
})

// Rich enough (>50 chars) and pattern-adjacent (middleware/pipeline/queue) so
// extractWithLLM's interest filter lets it through.
const INTERESTING_CONTENT =
  "// An event-driven middleware pipeline with a retry queue and dead-letter fallback.\n" +
  "// Dispatch arbitrary configuration events with graceful degradation.\n" +
  "export function dispatch(evt) {\n  pipeline.run(evt);\n  retries.enqueue(evt);\n}\n" +
  "padding-to-ensure-content-clearly-exceeds-fifty-characters"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.embedKnowledgeAsset.mockResolvedValue(undefined)
  mocks.analyzeCodePatterns.mockResolvedValue(SORTING_LANG_JSON)
  mocks.repoFindFirst.mockResolvedValue({ id: "repo-1" })
})

describe("normalizeDifficulty", () => {
  it("accepts only the three allowed values", () => {
    expect(normalizeDifficulty("beginner")).toBe("beginner")
    expect(normalizeDifficulty("intermediate")).toBe("intermediate")
    expect(normalizeDifficulty("advanced")).toBe("advanced")
  })

  it("rejects unknown, empty and non-string values with null", () => {
    expect(normalizeDifficulty("expert")).toBeNull()
    expect(normalizeDifficulty("")).toBeNull()
    expect(normalizeDifficulty("  beginner  ")).toBeNull()
    expect(normalizeDifficulty(1)).toBeNull()
    expect(normalizeDifficulty(null)).toBeNull()
    expect(normalizeDifficulty(undefined)).toBeNull()
  })
})

describe("parseCodeAnalysisResult", () => {
  it("strips markdown fences and extracts a valid difficulty", () => {
    const raw = "```json\n" + SORTING_LANG_JSON + "\n```"
    const parsed = parseCodeAnalysisResult(raw)
    expect(parsed.difficulty).toBe("intermediate")
    expect(parsed.summary).toBe(SORTING_LANG_JSON)
  })

  it("maps an invalid difficulty to null while keeping the summary", () => {
    const raw = JSON.stringify({ patternName: "Q", whatItDoes: "x", difficulty: "expert" })
    expect(parseCodeAnalysisResult(raw)).toEqual({ summary: raw, difficulty: null })
  })

  it("returns all-null when the payload is not valid JSON", () => {
    expect(parseCodeAnalysisResult("certainly not json")).toEqual({
      summary: null,
      difficulty: null,
    })
  })

  it("returns all-null for a non-object payload", () => {
    expect(parseCodeAnalysisResult("[1,2,3]")).toEqual({ summary: null, difficulty: null })
  })

  it("treats the LLM-failure fallback difficulty (empty) as null", () => {
    const fallback = JSON.stringify({
      patternName: "a.ts",
      whatItDoes: "LLM parse failed — retry or check manually",
      reuseValue: "",
      keyInsight: "",
      difficulty: "",
    })
    expect(parseCodeAnalysisResult(fallback)).toEqual({ summary: fallback, difficulty: null })
  })
})

describe("extractFromFile", () => {
  it("creates an asset with detected asset type and embeds it best-effort", async () => {
    mocks.create.mockResolvedValue({
      id: "asset-1",
      title: "quick-sort.ts",
      assetType: "algorithm",
    })

    const result = await extractFromFile(
      "user-1",
      "repo-1",
      "src/sort/quick-sort.ts",
      SORTING_CONTENT,
      "TypeScript",
    )

    expect(result).toEqual({ assetId: "asset-1", title: "quick-sort.ts", assetType: "algorithm" })
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "quick-sort.ts",
        description: "TypeScript file from repository",
        assetType: "algorithm",
        sourcePath: "src/sort/quick-sort.ts",
        content: expect.stringContaining("quickSort"),
        language: "TypeScript",
        tags: ["algorithm"],
        difficulty: null,
        repositoryId: "repo-1",
        userId: "user-1",
      }),
    })
    expect(mocks.embedKnowledgeAsset).toHaveBeenCalledWith("asset-1", expect.stringContaining("quickSort"))
  })

  it("returns null on a unique-constraint duplicate and skips embedding", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" })

    expect(await extractFromFile("user-1", "repo-1", "src/sort/quick-sort.ts", SORTING_CONTENT, "TypeScript")).toBeNull()
    expect(mocks.embedKnowledgeAsset).not.toHaveBeenCalled()
  })

  it("rethrows non-duplicate failures", async () => {
    mocks.create.mockRejectedValue(new Error("db unavailable"))

    await expect(
      extractFromFile("user-1", "repo-1", "src/sort/quick-sort.ts", SORTING_CONTENT, "TypeScript"),
    ).rejects.toThrow("db unavailable")
  })
})

describe("extractWithLLM", () => {
  it("rejects content outside the [50, 50000] length window", async () => {
    expect(await extractWithLLM("user-1", "repo-1", "a.ts", "too short", "TypeScript")).toBeNull()
    expect(await extractWithLLM("user-1", "repo-1", "a.ts", "x".repeat(50001), "TypeScript")).toBeNull()
    expect(mocks.analyzeCodePatterns).not.toHaveBeenCalled()
  })

  it("skips files that are not pattern-adjacent", async () => {
    const plain = "export function add(a, b) {\n  const total = a + b;\n  return total;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n"
    expect(await extractWithLLM("user-1", "repo-1", "src/math.ts", plain, "TypeScript")).toBeNull()
    expect(mocks.analyzeCodePatterns).not.toHaveBeenCalled()
  })

  it("runs the LLM and stores its analysis in the asset summary", async () => {
    mocks.create.mockResolvedValue({
      id: "asset-2",
      title: "dispatch.ts",
      assetType: "algorithm",
    })

    const content =
      "// Event-driven middleware pipeline with retry and a dead-letter queue.\n// Handles configuration events with graceful degradation and fallbacks.\nexport function dispatch(evt) {\n  pipeline.run(evt);\n}\n" +
      "padding-to-keep-length-comfortably-above-fifty-characters"

    const result = await extractWithLLM("user-1", "repo-1", "src/dispatch.ts", content, "TypeScript")

    expect(result).toEqual({ assetId: "asset-2", title: "dispatch.ts", assetType: "algorithm" })
    expect(mocks.analyzeCodePatterns).toHaveBeenCalledWith({
      userId: "user-1",
      repositoryId: "repo-1",
      content,
      fileName: "dispatch.ts",
      language: "TypeScript",
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "dispatch.ts",
        summary: SORTING_LANG_JSON,
        sourcePath: "src/dispatch.ts",
      }),
    })
    expect(mocks.embedKnowledgeAsset).toHaveBeenCalledWith(
      "asset-2",
      expect.stringContaining("dispatch.ts"),
    )
  })

  it("persists a validated difficulty parsed from the LLM JSON", async () => {
    mocks.create.mockResolvedValue({ id: "asset-3", title: "q.ts", assetType: "algorithm" })

    await extractWithLLM("user-1", "repo-1", "src/q.ts", INTERESTING_CONTENT, "TypeScript")

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        summary: SORTING_LANG_JSON,
        difficulty: "intermediate",
      }),
    })
    // Embedding content includes the sanitized summary so search can index it.
    expect(mocks.embedKnowledgeAsset).toHaveBeenCalledWith(
      "asset-3",
      expect.stringContaining("intermediate"),
    )
  })

  it("keeps difficulty null for an unknown LLM difficulty instead of fabricating one", async () => {
    mocks.analyzeCodePatterns.mockResolvedValue(
      JSON.stringify({ patternName: "Q", whatItDoes: "x", difficulty: "expert" }),
    )
    mocks.create.mockResolvedValue({ id: "asset-4", title: "q.ts", assetType: "algorithm" })

    await extractWithLLM("user-1", "repo-1", "src/q.ts", INTERESTING_CONTENT, "TypeScript")

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        difficulty: null,
      }),
    })
  })

  it("keeps summary and difficulty null when the LLM payload is not JSON", async () => {
    mocks.analyzeCodePatterns.mockResolvedValue("not json at all")
    mocks.create.mockResolvedValue({ id: "asset-5", title: "q.ts", assetType: "algorithm" })

    await extractWithLLM("user-1", "repo-1", "src/q.ts", INTERESTING_CONTENT, "TypeScript")

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        summary: null,
        difficulty: null,
      }),
    })
  })

  it("deduplicates via the unique constraint and skips embedding on P2002", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" })

    expect(await extractWithLLM("user-1", "repo-1", "src/q.ts", INTERESTING_CONTENT, "TypeScript")).toBeNull()
    expect(mocks.embedKnowledgeAsset).not.toHaveBeenCalled()
  })
})

describe("extractAssetsFromRepo", () => {
  const tree = [
    { path: "src/helper.ts", type: "file" as const, size: 100 },
    { path: "README.md", type: "file" as const, size: 500 },
  ]

  it("rejects extraction into a repository the user does not own", async () => {
    mocks.repoFindFirst.mockResolvedValue(null)
    mocks.fetchRepoFileTree.mockResolvedValue(tree)

    await expect(
      extractAssetsFromRepo("user-1", "repo-other", "owner", "repo", { maxFiles: 20, useLLM: false }),
    ).rejects.toThrow("Repository not found or not owned by this user")

    expect(mocks.fetchRepoFileTree).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("extracts known-extension files when useLLM=false and counts embedded assets", async () => {
    mocks.fetchRepoFileTree.mockResolvedValue(tree)
    mocks.findMany.mockResolvedValue([])
    mocks.fetchFileContent.mockResolvedValue(SORTING_CONTENT)
    mocks.create.mockResolvedValue({ id: "a", title: "x", assetType: "snippet" })

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", {
      maxFiles: 20,
      useLLM: false,
    })

    expect(result).toEqual({ extracted: 2, skipped: 0, embedded: 2 })
    expect(mocks.fetchRepoFileTree).toHaveBeenCalledWith("user-1", "owner", "repo")
    expect(mocks.fetchFileContent).toHaveBeenCalledTimes(2)
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })

  it("skips already-extracted paths from a previous run", async () => {
    mocks.fetchRepoFileTree.mockResolvedValue(tree)
    mocks.findMany.mockResolvedValue([{ sourcePath: "src/helper.ts" }])
    mocks.fetchFileContent.mockResolvedValue(SORTING_CONTENT)
    mocks.create.mockResolvedValue({ id: "a", title: "x", assetType: "snippet" })

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", {
      maxFiles: 20,
      useLLM: false,
    })

    expect(result).toEqual({ extracted: 1, skipped: 1, embedded: 1 })
  })

  it("skips short content but propagates upstream file-loading failures", async () => {
    mocks.fetchRepoFileTree.mockResolvedValue(tree)
    mocks.findMany.mockResolvedValue([])
    mocks.fetchFileContent.mockImplementation(async (_, __, ___, path: string) => {
      return path === "README.md" ? "tiny" : SORTING_CONTENT
    })
    mocks.create.mockResolvedValue({ id: "a", title: "x", assetType: "snippet" })

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", {
      maxFiles: 20,
      useLLM: false,
    })

    expect(result).toEqual({ extracted: 1, skipped: 1, embedded: 1 })

    mocks.fetchFileContent.mockRejectedValue(new Error("network"))
    await expect(
      extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", {
        maxFiles: 20,
        useLLM: false,
      }),
    ).rejects.toThrow("network")
  })

  it("routes through the LLM path when useLLM=true", async () => {
    mocks.fetchRepoFileTree.mockResolvedValue([{ path: "src/queue.ts", type: "file" as const, size: 100 }])
    mocks.findMany.mockResolvedValue([])
    mocks.fetchFileContent.mockResolvedValue(
      "// a message queue with retry, backpressure and a dead-letter architecture\n// for reliable job delivery\n",
    )
    mocks.create.mockResolvedValue({ id: "a", title: "queue.ts", assetType: "algorithm" })

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", {
      maxFiles: 20,
      useLLM: true,
    })

    expect(result).toEqual({ extracted: 1, skipped: 0, embedded: 1 })
    expect(mocks.analyzeCodePatterns).toHaveBeenCalledOnce()
  })
})