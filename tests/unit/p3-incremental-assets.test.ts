import { beforeEach, describe, expect, it, vi } from "vitest"

// ── P3 incremental extraction path (auto-sync) ──
// Targets extractAssetsFromRepo's automatic incremental behaviour: contentHash
// dedup, in-place refresh, legacy provenance backfill, and the explicit
// `sourceSha: null` empty-SHA fallback. All DB/GitHub/LLM deps mocked; no real
// DB, network or GitHub calls.

const mocks = vi.hoisted(() => ({
  repoFindFirst: vi.fn(),
  assetFindMany: vi.fn(),
  assetCreate: vi.fn(),
  assetUpdateMany: vi.fn(),
  analyzeCodePatterns: vi.fn(),
  embedKnowledgeAsset: vi.fn(),
  fetchRepoFileTree: vi.fn(),
  fetchFileContent: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { findFirst: mocks.repoFindFirst },
    knowledgeAsset: {
      findMany: mocks.assetFindMany,
      create: mocks.assetCreate,
      updateMany: mocks.assetUpdateMany,
    },
  },
}))
vi.mock("@/services/llm/analysis.service", () => ({ analyzeCodePatterns: mocks.analyzeCodePatterns }))
vi.mock("@/services/llm/embeddings.service", () => ({ embedKnowledgeAsset: mocks.embedKnowledgeAsset }))
vi.mock("@/services/github", () => ({
  fetchRepoFileTree: mocks.fetchRepoFileTree,
  fetchFileContent: mocks.fetchFileContent,
}))

import { createFileContentHash } from "@/services/analysis/content-fingerprint"
import { extractAssetsFromRepo } from "@/services/knowledge/extraction.service"

// Pattern-adjacent (>50 chars) so the auto-sync LLM path is exercised.
const CONTENT =
  "// Event-driven middleware pipeline with a retry queue and dead-letter fallback for reliable delivery.\n" +
  "// Dispatch arbitrary events with graceful degradation.\n" +
  "export function dispatch(evt) { pipeline.run(evt); retries.enqueue(evt); }\n"

const CHANGED_CONTENT =
  "// An observer-pattern dispatcher with a plugin extension point and a state machine underneath.\n" +
  "// Handles configuration events with a strategy pattern and graceful fallbacks.\n" +
  "export function dispatch(evt) { stateMachine.transition(evt); plugins.forEach((p) => p.handle(evt)); }\n"

const TREE = [{ path: "src/a.ts", type: "file" as const, size: 100 }]

const VALID_LLM_JSON = JSON.stringify({
  patternName: "DispatchHub",
  whatItDoes: "Routes events through a middleware pipeline",
  difficulty: "intermediate",
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repoFindFirst.mockResolvedValue({ id: "repo-1" })
  mocks.assetFindMany.mockResolvedValue([])
  mocks.assetCreate.mockResolvedValue({ id: "asset-x", title: "a.ts", assetType: "snippet" })
  mocks.assetUpdateMany.mockResolvedValue({ count: 1 })
  mocks.analyzeCodePatterns.mockResolvedValue(VALID_LLM_JSON)
  mocks.embedKnowledgeAsset.mockResolvedValue(undefined)
  mocks.fetchRepoFileTree.mockResolvedValue(TREE)
  mocks.fetchFileContent.mockResolvedValue(CONTENT)
})

describe("extractAssetsFromRepo — automatic incremental path", () => {
  const automatic = { sourceSha: "sha-abc", useLLM: true, maxFiles: 20 }

  it("skips an unchanged asset with the same contentHash — no LLM, no write", async () => {
    const unchangedHash = createFileContentHash(CONTENT)
    mocks.assetFindMany.mockResolvedValue([
      { id: "asset-1", sourcePath: "src/a.ts", contentHash: unchangedHash },
    ])

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", automatic)

    expect(result).toEqual({ extracted: 0, skipped: 1, embedded: 0 })
    expect(mocks.analyzeCodePatterns).not.toHaveBeenCalled()
    expect(mocks.assetUpdateMany).not.toHaveBeenCalled()
    expect(mocks.assetCreate).not.toHaveBeenCalled()
    expect(mocks.embedKnowledgeAsset).not.toHaveBeenCalled()
  })

  it("refreshes a changed asset in place — analyze + updateMany on the original id", async () => {
    const staleHash = "stale-hash-not-equal-to-anything"
    mocks.assetFindMany.mockResolvedValue([
      { id: "asset-1", sourcePath: "src/a.ts", contentHash: staleHash },
    ])
    mocks.fetchFileContent.mockResolvedValue(CHANGED_CONTENT)
    const newHash = createFileContentHash(CHANGED_CONTENT)

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", automatic)

    expect(result).toEqual({ extracted: 1, skipped: 0, embedded: 1 })
    expect(mocks.analyzeCodePatterns).toHaveBeenCalledTimes(1)
    expect(mocks.analyzeCodePatterns).toHaveBeenCalledWith({
      userId: "user-1",
      repositoryId: "repo-1",
      content: CHANGED_CONTENT,
      fileName: "a.ts",
      language: "TypeScript",
    })
    expect(mocks.assetUpdateMany).toHaveBeenCalledTimes(1)
    const [call] = mocks.assetUpdateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ]
    expect(call.where).toEqual({
      id: "asset-1",
      repositoryId: "repo-1",
      sourcePath: "src/a.ts",
      contentHash: staleHash,
    })
    expect(call.data).toMatchObject({
      content: CHANGED_CONTENT,
      sourceSha: "sha-abc",
      contentHash: newHash,
      summary: expect.any(String),
      difficulty: "intermediate",
      language: "TypeScript",
    })
    expect(mocks.assetCreate).not.toHaveBeenCalled()
    expect(mocks.embedKnowledgeAsset).toHaveBeenCalledWith("asset-1", expect.stringContaining("a.ts"))
  })

  it("backfills a legacy asset (contentHash null, stored bytes identical) with fingerprint only — no LLM", async () => {
    const hash = createFileContentHash(CONTENT)
    mocks.assetFindMany
      .mockResolvedValueOnce([{ id: "asset-legacy", sourcePath: "src/a.ts", contentHash: null }])
      .mockResolvedValueOnce([{ sourcePath: "src/a.ts", content: CONTENT }])

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", automatic)

    expect(result).toEqual({ extracted: 0, skipped: 1, embedded: 0 })
    expect(mocks.assetUpdateMany).toHaveBeenCalledTimes(1)
    const [call] = mocks.assetUpdateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ]
    expect(call.where).toEqual({
      id: "asset-legacy",
      repositoryId: "repo-1",
      sourcePath: "src/a.ts",
      contentHash: null,
    })
    expect(call.data).toEqual({ sourceSha: "sha-abc", contentHash: hash })
    expect(mocks.analyzeCodePatterns).not.toHaveBeenCalled()
    expect(mocks.assetCreate).not.toHaveBeenCalled()
  })

  it("still treats an explicit sourceSha:null automatic run as automatic (empty-SHA content fingerprint fallback)", async () => {
    // The GitHub sync passes the sourceSha KEY (possibly null for an empty,
    // never-pushed repository). Per the P3 contract an explicit null must still
    // mark the run automatic so the contentHash fingerprint is the fallback
    // cache key (provenance backfill records sourceSha null + contentHash).
    const hash = createFileContentHash(CONTENT)
    mocks.assetFindMany
      .mockResolvedValueOnce([{ id: "asset-legacy", sourcePath: "src/a.ts", contentHash: null }])
      .mockResolvedValueOnce([{ sourcePath: "src/a.ts", content: CONTENT }])

    const result = await extractAssetsFromRepo("user-1", "repo-1", "owner", "repo", {
      sourceSha: null,
      useLLM: true,
      maxFiles: 20,
    })

    expect(mocks.assetUpdateMany).toHaveBeenCalledTimes(1)
    const [call] = mocks.assetUpdateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ]
    expect(call.where).toMatchObject({ id: "asset-legacy", contentHash: null })
    expect(call.data).toEqual({ sourceSha: null, contentHash: hash })
    expect(mocks.analyzeCodePatterns).not.toHaveBeenCalled()
    expect(result).toEqual({ extracted: 0, skipped: 1, embedded: 0 })
  })
})