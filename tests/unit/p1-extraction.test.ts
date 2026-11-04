import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Extraction internals mocked; no real DB, GitHub or OpenAI access ──

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  analyzeCodePatterns: vi.fn(),
  embedKnowledgeAsset: vi.fn(),
  fetchRepoFileTree: vi.fn(),
  fetchFileContent: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    knowledgeAsset: { create: mocks.create, findMany: mocks.findMany },
  },
}))
vi.mock("@/services/llm/analysis.service", () => ({ analyzeCodePatterns: mocks.analyzeCodePatterns }))
vi.mock("@/services/llm/embeddings.service", () => ({ embedKnowledgeAsset: mocks.embedKnowledgeAsset }))
vi.mock("@/services/github", () => ({
  fetchRepoFileTree: mocks.fetchRepoFileTree,
  fetchFileContent: mocks.fetchFileContent,
}))

import { extractFromFile, extractWithLLM, extractAssetsFromRepo } from "@/services/knowledge/extraction.service"

const SORTING_CONTENT =
  "function quickSort(list) {\n  if (list.length <= 1) return list;\n  const pivot = list[0];\n  const rest = list.slice(1);\n  return [...quickSort(rest.filter((x) => x < pivot)), pivot, ...quickSort(rest.filter((x) => x >= pivot))];\n}"

const SORTING_LANG_JSON = JSON.stringify({
  patternName: "QuickSort",
  whatItDoes: "Recursive divide and conquer sorting",
  reuseValue: "Use for stable sorting by a key",
  keyInsight: "Pick a median pivot",
  difficulty: "intermediate",
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.embedKnowledgeAsset.mockResolvedValue(undefined)
  mocks.analyzeCodePatterns.mockResolvedValue(SORTING_LANG_JSON)
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
})

describe("extractAssetsFromRepo", () => {
  const tree = [
    { path: "src/helper.ts", type: "file" as const, size: 100 },
    { path: "README.md", type: "file" as const, size: 500 },
  ]

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

  it("skips files whose content is too short or fails to load", async () => {
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
    const failed = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", {
      maxFiles: 20,
      useLLM: false,
    })
    expect(failed).toEqual({ extracted: 0, skipped: 2, embedded: 0 })
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