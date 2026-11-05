/**
 * P3 — automatic incremental analysis enqueue (AI auto-sync).
 *
 * Called by the GitHub sync pipeline (which supplies `sourceSha`) whenever a
 * repository is added, updated, or re-starred. Unlike the manual
 * `enqueueRepoSummary` / `enqueueAssetExtraction` server actions, this path is
 * *sourceSha-aware*:
 *
 *   * an in-flight (pending/running) task for the same user/repo/type is
 *     reused — never stacked;
 *   * when `sourceSha` is present, a previous *completed* task for the exact
 *     same user/repo/type/*sourceSha* satisfies the request (the repository has
 *     not changed since the last analysis ran);
 *   * when `sourceSha` is null the completed-check is intentionally skipped so
 *     an existing summary is not assumed valid — the worker's README/content
 *     fingerprint (see `content-fingerprint.ts`) is the authoritative fallback;
 *   * every enqueued task is flagged `{ automatic: true, reason, sourceSha }`
 *     in its `input`, and the top-level `Analysis.sourceSha` column carries the
 *     same value for cheap SQL-level dedup.
 *
 * All reliability guarantees from P1/P2 are kept: the ownership gate, the
 * active partial-unique-index race, and the concurrent P2002 → winner-dedup
 * behaviour. No task is ever deleted or rescheduled here; a stale sourceSha
 * simply means the next sync enqueues a newer task.
 */

import { prisma } from "@/lib/prisma"
import type { Prisma } from "@prisma/client"
import { assertRepositoryOwned } from "@/services/intake/repository-ownership"
import { findActiveAnalysis } from "@/services/intake/enqueue-analysis"

export const REPO_SUMMARY_ANALYSIS_TYPE = "repo_summary"
export const ASSET_EXTRACTION_ANALYSIS_TYPE = "asset_extraction"

export type AutoAnalysisReason = "new" | "updated" | "restarred"

export interface QueueChangedRepositoryAnalysisInput {
  repositoryId: string
  userId: string
  sourceSha: string | null
  reason: AutoAnalysisReason
}

export interface QueueChangedRepositoryAnalysisResult {
  /** Number of pending tasks actually created across both analysis types. */
  queued: number
  /**
   * Number of tasks skipped because an equivalent task was already active or,
   * for a non-null sourceSha, already completed for that source snapshot.
   */
  skipped: number
}

/** Prisma unique-constraint violation code (PostgreSQL 23505). */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002"
}

interface PendingPayload {
  analysisType: string
  input: Prisma.InputJsonObject
  sourceSha: string | null
}

/** Build the auto-task input for one analysis type. */
function buildAutoInput(
  analysisType: string,
  sourceSha: string | null,
  reason: AutoAnalysisReason
): PendingPayload {
  const base: Prisma.InputJsonObject = {
    automatic: true,
    reason,
    sourceSha: sourceSha ?? null,
  }
  if (analysisType === ASSET_EXTRACTION_ANALYSIS_TYPE) {
    // Preserve the manual extraction defaults (P1 contract).
    return {
      analysisType,
      input: { ...base, maxFiles: 20, useLLM: true },
      sourceSha,
    }
  }
  return { analysisType, input: base, sourceSha }
}

/**
 * A completed task covering exactly this repository snapshot (same sourceSha).
 * Never invoked with a null sourceSha — the caller guards on that so a null
 * sourceSha never treats an arbitrary historical summary as up-to-date.
 */
async function findCompletedForSourceSha(
  repositoryId: string,
  userId: string,
  analysisType: string,
  sourceSha: string
): Promise<{ id: string } | null> {
  return prisma.analysis.findFirst({
    where: {
      repositoryId,
      userId,
      analysisType,
      status: "completed",
      sourceSha,
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  })
}

/**
 * Create one pending task under the active partial-unique-index race.
 * Resolves `"conflict"` when a concurrent enqueue won the race (P2002), so the
 * caller can re-query the winner and count it as skipped.
 */
async function createPending(
  repositoryId: string,
  userId: string,
  payload: PendingPayload
): Promise<"queued" | "conflict"> {
  try {
    await prisma.analysis.create({
      data: {
        analysisType: payload.analysisType,
        status: "pending",
        repositoryId,
        userId,
        input: payload.input,
        sourceSha: payload.sourceSha,
      },
    })
    return "queued"
  } catch (error) {
    if (isUniqueViolation(error)) return "conflict"
    throw error
  }
}

/**
 * P3 running/pending sourceSha follow-up (closed loop).
 *
 * A new sourceSha arriving while an *older* task is still in flight must not be
 * dropped, otherwise the new snapshot is never analyzed (the sync no longer
 * re-enqueues unchanged repos):
 *
 *   * a still-`pending` task is *conditionally bumped* to the newest sourceSha
 *     (fenced on `id + status = pending + old sourceSha`, so a concurrently
 *     claimed task is never mutated);
 *   * a `running` task cannot be mutated safely; the worker's post-completion
 *     follow-up (see `analysis-worker.ts`) re-checks `Repository.headSha` once
 *     the old task finishes and calls back into this function — still subject to
 *     the active/completed dedup below, so it can never stack or recurse.
 */
async function bumpPendingSourceSha(
  repositoryId: string,
  userId: string,
  analysisType: string,
  nextSourceSha: string,
  reason: AutoAnalysisReason
): Promise<void> {
  const active = await prisma.analysis.findFirst({
    where: {
      repositoryId,
      userId,
      analysisType,
      status: { in: ["pending", "running"] },
    },
    select: { id: true, sourceSha: true, status: true },
    orderBy: { createdAt: "asc" },
  })
  if (!active || active.status !== "pending") return
  if (active.sourceSha === nextSourceSha) return

  await prisma.analysis.updateMany({
    where: { id: active.id, status: "pending", sourceSha: active.sourceSha },
    data: {
      sourceSha: nextSourceSha,
      input: buildAutoInput(analysisType, nextSourceSha, reason).input,
    },
  })
}

/**
 * Enqueue (or reuse) the two automatic analysis tasks for a changed repository.
 *
 * `repo_summary` and `asset_extraction` are handled independently so a repo
 * that only needs re-summarizing still skips a redundant re-extraction and
 * vice versa.
 */
export async function queueChangedRepositoryAnalysis(
  input: QueueChangedRepositoryAnalysisInput
): Promise<QueueChangedRepositoryAnalysisResult> {
  const { repositoryId, userId, sourceSha, reason } = input

  // 0. Ownership gate — refuse to enqueue an illegal / foreign repository.
  await assertRepositoryOwned(repositoryId, userId)

  let queued = 0
  let skipped = 0

  for (const analysisType of [
    REPO_SUMMARY_ANALYSIS_TYPE,
    ASSET_EXTRACTION_ANALYSIS_TYPE,
  ]) {
    // 1. Reuse an in-flight task — pending/running rows can never be stacked
    //    (the active partial unique index enforces this, and manual enqueues
    //    rely on the same rule). A pending task is bumped to the newest
    //    sourceSha so a source change during the queue window is not lost.
    const active = await findActiveAnalysis(repositoryId, userId, analysisType)
    if (active) {
      if (sourceSha != null) {
        await bumpPendingSourceSha(repositoryId, userId, analysisType, sourceSha, reason)
      }
      skipped++
      continue
    }

    // 2. A completed task for the exact same source snapshot is good enough.
    //    Only when sourceSha is present — a null sourceSha must not skip on an
    //    arbitrary historical completion (the worker fingerprint decides).
    if (sourceSha) {
      const completed = await findCompletedForSourceSha(
        repositoryId,
        userId,
        analysisType,
        sourceSha
      )
      if (completed) {
        skipped++
        continue
      }
    }

    // 3. Queue it. The partial unique index makes the insert race-safe; the
    //    loser observes P2002 and resolves to the winner as *skipped*.
    const outcome = await createPending(
      repositoryId,
      userId,
      buildAutoInput(analysisType, sourceSha, reason)
    )

    if (outcome === "queued") {
      queued++
    } else {
      const winner = await findActiveAnalysis(repositoryId, userId, analysisType)
      if (winner) {
        if (sourceSha != null) {
          await bumpPendingSourceSha(repositoryId, userId, analysisType, sourceSha, reason)
        }
        skipped++
      } else {
        throw new Error(
          `Concurrent enqueue conflict for ${analysisType} but no active task was found (repositoryId=${repositoryId})`
        )
      }
    }
  }

  return { queued, skipped }
}