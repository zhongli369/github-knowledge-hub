import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GitHubRepo } from "@/services/github"

// ── P3 auto-sync reliability (P3, D-tier) ──
// High-value DB-mocked tests only: auto-analysis sourceSha dedup, active-task
// dedup, and sync-run per-repo failure isolation. No real DB / network access.

const prismaMocks = vi.hoisted(() => ({
  repoFindMany: vi.fn(),
  repoCreate: vi.fn(),
  repoUpdate: vi.fn(),
  runFindFirst: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  runUpdateMany: vi.fn(),
  runFindUniqueOrThrow: vi.fn(),
  analysisFindFirst: vi.fn(),
  analysisCreate: vi.fn(),
  analysisUpdateMany: vi.fn(),
}))

const githubMocks = vi.hoisted(() => ({
  fetchStarredRepos: vi.fn(),
  fetchRepositoryHeadSha: vi.fn(),
}))

const intakeMocks = vi.hoisted(() => ({
  assertRepositoryOwned: vi.fn(),
  findActiveAnalysis: vi.fn(),
  enqueueRepoClassification: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: {
      findMany: prismaMocks.repoFindMany,
      create: prismaMocks.repoCreate,
      update: prismaMocks.repoUpdate,
    },
    syncRun: {
      findFirst: prismaMocks.runFindFirst,
      create: prismaMocks.runCreate,
      update: prismaMocks.runUpdate,
      updateMany: prismaMocks.runUpdateMany,
      findUniqueOrThrow: prismaMocks.runFindUniqueOrThrow,
    },
    analysis: {
      findFirst: prismaMocks.analysisFindFirst,
      create: prismaMocks.analysisCreate,
      updateMany: prismaMocks.analysisUpdateMany,
    },
  },
}))
vi.mock("@/services/github/repos.service", () => ({
  fetchStarredRepos: githubMocks.fetchStarredRepos,
  fetchRepositoryHeadSha: githubMocks.fetchRepositoryHeadSha,
}))
vi.mock("@/services/intake/repository-ownership", () => ({
  assertRepositoryOwned: intakeMocks.assertRepositoryOwned,
}))
vi.mock("@/services/intake/enqueue-analysis", () => ({
  findActiveAnalysis: intakeMocks.findActiveAnalysis,
  enqueueRepoClassification: intakeMocks.enqueueRepoClassification,
}))

import {
  runUserSync,
  SyncRunInProgressError,
  SYNC_RUN_STALE_TIMEOUT_MS,
  SYNC_RUN_TIMED_OUT_MESSAGE,
} from "@/services/sync/incremental-sync.service"
import { queueChangedRepositoryAnalysis } from "@/services/analysis/auto-analysis.service"

const NOW = new Date("2026-01-01T00:00:00.000Z")

function repoA(): GitHubRepo {
  return {
    id: 11,
    owner: "o",
    name: "a",
    fullName: "o/a",
    description: "repo a",
    url: "https://github.com/o/a",
    homepage: null,
    language: "Go",
    stars: 5,
    forks: 1,
    topics: ["http"],
    defaultBranch: "main",
    isArchived: false,
    isTemplate: false,
    license: "MIT",
    size: 100,
    pushedAt: "2026-02-01T00:00:00Z",
  }
}

function repoB(): GitHubRepo {
  return {
    id: 22,
    owner: "o",
    name: "b",
    fullName: "o/b",
    description: null,
    url: "https://github.com/o/b",
    homepage: null,
    language: "TypeScript",
    stars: 2,
    forks: 0,
    topics: [],
    defaultBranch: "main",
    isArchived: false,
    isTemplate: false,
    license: null,
    size: 40,
    pushedAt: "2026-03-01T00:00:00Z",
  }
}

const existingARow = {
  id: "repo-a",
  githubId: 11,
  fullName: "o/a",
  description: "repo a",
  language: "Go",
  homepage: null,
  defaultBranch: "main",
  isArchived: false,
  isTemplate: false,
  license: "MIT",
  size: 100,
  topics: ["http"],
  headSha: "old-sha",
  syncHash: "old-hash",
  pushedAt: new Date("2026-01-01T00:00:00Z"),
  unstarredAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  prismaMocks.runFindFirst.mockResolvedValue(null)
  prismaMocks.runCreate.mockResolvedValue({ id: "run-1" })
  prismaMocks.runUpdateMany.mockResolvedValue({ count: 0 })
  prismaMocks.repoFindMany.mockResolvedValue([])
  prismaMocks.repoCreate.mockResolvedValue({ id: "repo-b-row" })
  prismaMocks.repoUpdate.mockResolvedValue({})
  prismaMocks.analysisFindFirst.mockResolvedValue(null)
  prismaMocks.analysisCreate.mockResolvedValue({ id: "analysis-x" })
  prismaMocks.runFindUniqueOrThrow.mockResolvedValue({
    totalCount: 2,
    processedCount: 2,
    addedCount: 1,
    updatedCount: 0,
    unchangedCount: 0,
    unstarredCount: 0,
    failedCount: 1,
    analysisQueuedCount: 2,
  })
  githubMocks.fetchStarredRepos.mockResolvedValue([])
  githubMocks.fetchRepositoryHeadSha.mockResolvedValue("sha-default")
  intakeMocks.assertRepositoryOwned.mockResolvedValue(true)
  intakeMocks.findActiveAnalysis.mockResolvedValue(null)
  intakeMocks.enqueueRepoClassification.mockResolvedValue({
    analysisId: "classification-1",
    status: "queued",
  })
})

describe("runUserSync — sync-run reliability", () => {
  it("continues past a failing repository and completes the run", async () => {
    githubMocks.fetchStarredRepos.mockResolvedValue([repoA(), repoB()])
    prismaMocks.repoFindMany.mockResolvedValue([existingARow])
    // repoA (existing, pushedAt moved) fails its HEAD fetch; repoB must still be added.
    githubMocks.fetchRepositoryHeadSha.mockImplementation(
      async (_userId: string, _owner: string, name: string) => {
        if (name === "a") throw new Error("upstream 403 rate limit")
        return "sha-b"
      },
    )

    const summary = await runUserSync({
      userId: "u1",
      trigger: "scheduled",
      autoAnalyze: true,
      now: NOW,
    })

    expect(summary.status).toBe("completed")
    expect(summary.failedCount).toBe(1)
    // Processing did not stop at repoA: repoB was created.
    expect(prismaMocks.repoCreate).toHaveBeenCalledTimes(1)
    expect(prismaMocks.repoCreate.mock.calls[0][0]?.data?.githubId).toBe(22)

    const updateData = prismaMocks.runUpdate.mock.calls.map((call) => call[0]?.data)
    expect(updateData).toContainEqual(expect.objectContaining({ failedCount: { increment: 1 } }))
    expect(updateData).toContainEqual(expect.objectContaining({ addedCount: { increment: 1 } }))
    expect(updateData).toContainEqual(expect.objectContaining({ analysisQueuedCount: { increment: 2 } }))
    expect(updateData).toContainEqual(expect.objectContaining({ status: "completed" }))
  })

  it("rejects a second run while one is already running (active run dedup)", async () => {
    prismaMocks.runFindFirst.mockResolvedValue({ id: "run-0" })

    await expect(runUserSync({ userId: "u1", trigger: "scheduled" })).rejects.toBeInstanceOf(
      SyncRunInProgressError,
    )
    expect(githubMocks.fetchStarredRepos).not.toHaveBeenCalled()
    expect(prismaMocks.runCreate).not.toHaveBeenCalled()
  })

  it("maps the concurrent P2002 insert race onto SyncRunInProgressError", async () => {
    prismaMocks.runCreate.mockRejectedValue(Object.assign(new Error("dup run"), { code: "P2002" }))

    await expect(runUserSync({ userId: "u1", trigger: "scheduled" })).rejects.toBeInstanceOf(
      SyncRunInProgressError,
    )
  })

  it("reaps a stale running run (crashed process) before the active check, then starts fresh", async () => {
    prismaMocks.runUpdateMany.mockResolvedValue({ count: 1 })
    githubMocks.fetchStarredRepos.mockResolvedValue([])

    const summary = await runUserSync({ userId: "u1", trigger: "scheduled", now: NOW })

    // Only rows whose updatedAt is older than the fixed 30-min cutoff are reaped.
    expect(prismaMocks.runUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        status: "running",
        updatedAt: { lt: new Date(NOW.getTime() - SYNC_RUN_STALE_TIMEOUT_MS) },
      },
      data: { status: "failed", error: SYNC_RUN_TIMED_OUT_MESSAGE, finishedAt: NOW },
    })
    // Reaped run no longer blocks: a fresh run is created and completes.
    expect(prismaMocks.runCreate).toHaveBeenCalledTimes(1)
    expect(summary.status).toBe("completed")
  })

  it("still rejects a live running sync (recently bumped) even after the stale-reaping pass", async () => {
    prismaMocks.runFindFirst.mockResolvedValue({ id: "run-0" })

    await expect(
      runUserSync({ userId: "u1", trigger: "scheduled", now: NOW }),
    ).rejects.toBeInstanceOf(SyncRunInProgressError)

    // The recovery pass still ran first; the live row's fresh updatedAt keeps it
    // out of the reap scope (where clause is limited to < 30min-old rows), so the
    // active pre-check still sees it as running.
    expect(prismaMocks.runUpdateMany).toHaveBeenCalledTimes(1)
    expect(prismaMocks.runUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        status: "running",
        updatedAt: { lt: new Date(NOW.getTime() - SYNC_RUN_STALE_TIMEOUT_MS) },
      },
      data: { status: "failed", error: SYNC_RUN_TIMED_OUT_MESSAGE, finishedAt: NOW },
    })
    expect(githubMocks.fetchStarredRepos).not.toHaveBeenCalled()
    expect(prismaMocks.runCreate).not.toHaveBeenCalled()
  })
})

describe("queueChangedRepositoryAnalysis — sourceSha-aware dedup", () => {
  it("does not enqueue when a completed task already covers the exact same sourceSha", async () => {
    prismaMocks.analysisFindFirst.mockResolvedValue({ id: "completed-1" })

    const result = await queueChangedRepositoryAnalysis({
      repositoryId: "repo-1",
      userId: "u1",
      sourceSha: "sha-abc",
      reason: "new",
    })

    expect(result).toEqual({ queued: 0, skipped: 2 })
    expect(prismaMocks.analysisCreate).not.toHaveBeenCalled()
  })

  it("does not stack automatic tasks on an in-flight task (active dedup)", async () => {
    intakeMocks.findActiveAnalysis.mockResolvedValue({
      analysisId: "pending-1",
      status: "already_queued",
    })

    const result = await queueChangedRepositoryAnalysis({
      repositoryId: "repo-1",
      userId: "u1",
      sourceSha: "sha-abc",
      reason: "updated",
    })

    expect(result).toEqual({ queued: 0, skipped: 2 })
    expect(prismaMocks.analysisCreate).not.toHaveBeenCalled()
  })

  it("enqueues both automatic task types when nothing matches", async () => {
    const result = await queueChangedRepositoryAnalysis({
      repositoryId: "repo-1",
      userId: "u1",
      sourceSha: "sha-abc",
      reason: "restarred",
    })

    expect(result).toEqual({ queued: 2, skipped: 0 })
    expect(prismaMocks.analysisCreate).toHaveBeenCalledTimes(2)
    const types = prismaMocks.analysisCreate.mock.calls.map((call) => call[0]?.data?.analysisType)
    expect(types).toEqual(["repo_summary", "asset_extraction"])
    const summaryTask = prismaMocks.analysisCreate.mock.calls[0][0]?.data
    expect(summaryTask).toMatchObject({
      analysisType: "repo_summary",
      status: "pending",
      sourceSha: "sha-abc",
      userId: "u1",
      repositoryId: "repo-1",
      input: { automatic: true, reason: "restarred", sourceSha: "sha-abc" },
    })
  })

  it("ignores a completed task when sourceSha is null (worker fingerprint decides)", async () => {
    prismaMocks.analysisFindFirst.mockResolvedValue({ id: "completed-old" })

    const result = await queueChangedRepositoryAnalysis({
      repositoryId: "repo-1",
      userId: "u1",
      sourceSha: null,
      reason: "new",
    })

    expect(result.queued).toBe(2)
    expect(prismaMocks.analysisFindFirst).not.toHaveBeenCalled()
  })
})

describe("runUserSync — stars-only churn never enqueues analysis or refetches HEAD", () => {
  it("persists the new star/forks counts and stays unchanged with analysisQueuedCount 0", async () => {
    // The existing row is fully known (HEAD captured, pushedAt identical, no
    // re-star, no metadata drift). Only the engagement counts move.
    prismaMocks.repoFindMany.mockResolvedValue([
      {
        ...existingARow,
        owner: "o",
        name: "a",
        url: "https://github.com/o/a",
        starredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ])
    githubMocks.fetchStarredRepos.mockResolvedValue([
      { ...repoA(), stars: 999, forks: 88, pushedAt: "2026-01-01T00:00:00Z" },
    ])

    const summary = await runUserSync({
      userId: "u1",
      trigger: "scheduled",
      autoAnalyze: true,
      now: NOW,
    })

    // No per-repo GitHub call (HEAD already known, pushedAt unchanged).
    expect(githubMocks.fetchRepositoryHeadSha).not.toHaveBeenCalled()
    // No AI analysis or classification task was created.
    expect(prismaMocks.analysisCreate).not.toHaveBeenCalled()
    expect(intakeMocks.enqueueRepoClassification).not.toHaveBeenCalled()
    // The row refresh only touches engagement + heartbeat fields.
    const updateData = prismaMocks.repoUpdate.mock.calls.map((call) => call[0]?.data)
    expect(updateData).toContainEqual(
      expect.objectContaining({ stars: 999, forks: 88, lastFetchedAt: NOW }),
    )
    expect(summary.unchangedCount).toBe(1)
    expect(summary.analysisQueuedCount).toBe(0)
  })
})

describe("runUserSync — metadata-only changes reclassify without reanalysis", () => {
  it("enqueues fingerprinted classification but no HEAD, summary, or asset work", async () => {
    prismaMocks.repoFindMany.mockResolvedValue([
      {
        ...existingARow,
        owner: "o",
        name: "a",
        url: "https://github.com/o/a",
        starredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ])
    githubMocks.fetchStarredRepos.mockResolvedValue([
      {
        ...repoA(),
        description: "updated functional description",
        stars: 999,
        pushedAt: "2026-01-01T00:00:00Z",
      },
    ])

    const summary = await runUserSync({
      userId: "u1",
      trigger: "scheduled",
      autoAnalyze: true,
      now: NOW,
    })

    expect(githubMocks.fetchRepositoryHeadSha).not.toHaveBeenCalled()
    expect(prismaMocks.analysisCreate).not.toHaveBeenCalled()
    expect(intakeMocks.enqueueRepoClassification).toHaveBeenCalledWith("repo-a", "u1", {
      mode: "all",
      force: false,
    })
    expect(summary.updatedCount).toBe(1)
    expect(summary.analysisQueuedCount).toBe(1)
  })
})

describe("queueChangedRepositoryAnalysis — closed-loop sourceSha bump on a pending task", () => {
  it("bumps the pending task's sourceSha instead of stacking a second row", async () => {
    // A still-pending task for user/repo/type exists with an older snapshot.
    intakeMocks.findActiveAnalysis.mockResolvedValue({
      analysisId: "pending-1",
      status: "already_queued",
    })
    // bumpPendingSourceSha re-reads the active row directly (raw prisma).
    prismaMocks.analysisFindFirst.mockResolvedValue({
      id: "pending-1",
      sourceSha: "old-sha",
      status: "pending",
    })

    const result = await queueChangedRepositoryAnalysis({
      repositoryId: "repo-1",
      userId: "u1",
      sourceSha: "new-sha",
      reason: "updated",
    })

    expect(result).toEqual({ queued: 0, skipped: 2 })
    // No second pending row was inserted.
    expect(prismaMocks.analysisCreate).not.toHaveBeenCalled()
    // Both task types bumped their pending row to the newest source snapshot.
    expect(prismaMocks.analysisUpdateMany).toHaveBeenCalledTimes(2)
    const [firstBump] = prismaMocks.analysisUpdateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ]
    expect(firstBump.where).toEqual({ id: "pending-1", status: "pending", sourceSha: "old-sha" })
    expect(firstBump.data).toMatchObject({
      sourceSha: "new-sha",
      input: { automatic: true, reason: "updated", sourceSha: "new-sha" },
    })
  })
})
