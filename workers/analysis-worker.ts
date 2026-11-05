#!/usr/bin/env node
/**
 * Background analysis worker (P1 Agent B).
 *
 * Usage: npm run worker
 *
 * Polls for claimable analyses and processes them via services (LLM +
 * extraction). A task is claimed atomically through PostgreSQL
 * (FOR UPDATE SKIP LOCKED); the lease is renewed by a heartbeat while a task
 * is processed; terminal updates are conditional on the worker still owning a
 * valid lease and carrying the correct fencing token so a stale worker can
 * never overwrite a newer worker's result.
 *
 * Reliability model:
 *   * True concurrency pool — up to MAX_CONCURRENT tasks in flight at once.
 *   * Bounded retries — each claim increments `attempts`; the lease layer caps
 *     re-claims at MAX_ATTEMPTS and terminally fails poisoned tasks.
 *   * Heartbeat watch — every `renewLease` failure marks the claim dead; once
 *     dead, no further asset/result writes are attempted (the fencing writes
 *     in leasing.service would reject them anyway, but the worker also stops
 *     launching them).
 *   * Monotonic fencing — `analysis.attempts` captured at claim time is passed
 *     into every renew/complete/fail, so a reclaimed task can never be
 *     mutated by its stale owner.
 *   * Task timeout — a hard wall-clock ceiling per processing run; on timeout
 *     the task is failed and retried (bounded by attempts), never completed.
 *   * Ownership verification — the worker refuses to process an analysis whose
 *     repository is not owned by `analysis.userId`; such tasks fail closed and
 *     no assets are ever written.
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { prisma } from "@/lib/prisma"
import {
  analyzeRepoSummary,
  AnalysisError,
  type RepoSummary,
} from "@/services/llm/analysis.service"
import { extractAssetsFromRepo } from "@/services/knowledge/extraction.service"
import { fetchRepoReadme } from "@/services/github"
import { createAnalysisContentHash } from "@/services/analysis/content-fingerprint"
import {
  claimNextAnalysis,
  completeAnalysis,
  failAnalysis,
  renewLease,
  createWorkerId,
  HEARTBEAT_INTERVAL_MS,
  type ClaimableAnalysis,
} from "@/services/analysis/leasing.service"

export const POLL_INTERVAL_MS = 5_000

/** How many analyses may be processed concurrently in this process. */
export const MAX_CONCURRENT = 3

/**
 * Hard wall-clock budget for a single processing run. Overridable through
 * `WORKER_TASK_TIMEOUT_MS` (milliseconds) for tests and constrained deploys.
 * The lease is far shorter (60s) and renewed by heartbeat, so this is purely a
 * last-resort abort for genuinely hung calls (e.g. a wedged LLM/native fetch).
 */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000

function taskTimeoutMs(): number {
  const raw = Number(process.env.WORKER_TASK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TASK_TIMEOUT_MS
}

// Unique identity for this worker process. Overridable for tests/containers.
const WORKER_ID = process.env.WORKER_ID || createWorkerId()

/** Claims currently being processed. The pool guard and the main loop read it. */
export const activeJobs = new Set<Promise<void>>()

/** Thrown internally to suppress writes once a claim is dead/timeout/reclaimed. */
export class LeaseLostError extends Error {
  constructor(message?: string) {
    super(message ?? "Lease lost or task cancelled")
    this.name = "LeaseLostError"
  }
}

export class TaskTimeoutError extends Error {
  constructor(taskId: string, ms: number) {
    super(`Task ${taskId} exceeded ${ms}ms timeout`)
    this.name = "TaskTimeoutError"
  }
}

class OwnershipMismatchError extends Error {
  override readonly name = "OwnershipMismatchError"
}

/**
 * Per-claim cancellation/watchdog state.
 *
 * `alive` flips to false when the heartbeat stops succeeding, the task exceeds
 * its timeout, or — defensively — when the claim is otherwise no longer owned.
 * All subsequent writes are gated on `isAlive()`.
 */
interface ClaimContext {
  analysisId: string
  alive: boolean
  reason: string | null
  isAlive(): boolean
  cancel(reason: string): void
}

function createContext(analysisId: string): ClaimContext {
  const ctx: ClaimContext = {
    analysisId,
    alive: true,
    reason: null,
    isAlive() {
      return ctx.alive
    },
    cancel(reason: string) {
      if (ctx.alive) {
        ctx.alive = false
        ctx.reason = reason
      }
    },
  }
  return ctx
}

/**
 * Run `promise`, but reject with `makeError()` after `ms` and invoke
 * `onTimeout` so the caller can mark the work cancelled. The underlying
 * promise keeps running in the background; its late result is ignored because
 * every write it attempts after cancellation is gated on `isAlive()`.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
  makeError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(makeError())
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Security boundary: refuse to work a task whose repository is not owned by the analysis owner. */
function assertOwnership(repoUserId: string, analysisUserId: string, analysisId: string): void {
  if (repoUserId !== analysisUserId) {
    throw new OwnershipMismatchError(
      `Ownership mismatch: analysis ${analysisId} is owned by userId=${analysisUserId} but its repository belongs to userId=${repoUserId}`,
    )
  }
}

/** Stable repo metadata the summary fingerprint is computed from (no volatile counts). */
interface SummaryFingerprintMeta {
  name: string
  fullName: string
  description: string | null
  language: string | null
  topics: string[]
  url: string
  defaultBranch: string
}

/**
 * P3 content dedup for *automatic* `repo_summary` tasks.
 *
 * Before the LLM is paid for, fingerprint the task inputs (stable metadata +
 * README) and look for a previously completed summary with the same fingerprint
 * for this user/repo. On a hit the current task is completed by *reusing* that
 * result (tokensUsed/durationMs = 0, `cached: true`,
 * `skippedReason: "content_unchanged"`); the LLM is never called.
 *
 * The current task's own fingerprint is first persisted fenced on the running
 * claim (`id` + `workerId` + `attempts` + running lease), so the value is on
 * the row when it completes — even when the task later completes through the
 * normal `analyzeRepoSummary` path.
 *
 * Returns `true` when the task was already completed (cached) and no further
 * processing is allowed; `false` when it should fall through to the normal LLM
 * path. Manual/legacy tasks never enter here (backward compatible).
 */
async function maybeReuseCachedSummary(
  analysis: ClaimableAnalysis,
  ctx: ClaimContext,
  repo: SummaryFingerprintMeta,
  readme: string | null,
  ownerSummary: { fullName: string }
): Promise<boolean> {
  if (!analysis.repositoryId) return false

  const contentHash = createAnalysisContentHash({
    metadata: {
      name: repo.name,
      fullName: repo.fullName,
      description: repo.description,
      language: repo.language,
      // GitHub returns topics in an unstable order; sort before hashing so a
      // reordered topic list cannot fabricate a spurious content change.
      topics: [...repo.topics].sort(),
      url: repo.url,
      defaultBranch: repo.defaultBranch,
    },
    readme,
  })

  // Persist this run's fingerprint fenced on the running claim. The WHERE clause
  // matches ONLY while this worker still owns a valid lease at the same fencing
  // attempt; when it no longer does (reclaimed/timeout/attempt changed) ZERO rows
  // are updated and the run must stop BEFORE the LLM is paid for — otherwise we
  // would find after the call that the task can no longer be completed.
  const fingerprintWrite = await prisma.analysis.updateMany({
    where: {
      id: analysis.id,
      workerId: WORKER_ID,
      status: "running",
      leaseExpiresAt: { gt: new Date() },
      attempts: analysis.attempts,
    },
    data: { contentHash },
  })
  if (fingerprintWrite.count !== 1) throw new LeaseLostError()

  if (!ctx.isAlive()) throw new LeaseLostError()

  const cached = await prisma.analysis.findFirst({
    where: {
      repositoryId: analysis.repositoryId,
      userId: analysis.userId,
      analysisType: "repo_summary",
      status: "completed",
      contentHash,
      NOT: { id: analysis.id },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true, model: true },
  })

  const cachedResult = (cached?.result as Record<string, unknown> | null) ?? null
  const summary = (cachedResult?.summary as RepoSummary | undefined) ?? null
  if (!cached || !summary) return false

  if (!ctx.isAlive()) throw new LeaseLostError()

  const completed = await completeAnalysis({
    analysisId: analysis.id,
    workerId: WORKER_ID,
    status: "completed",
    result: JSON.parse(
      JSON.stringify({
        summary,
        rawContent: (cachedResult?.rawContent as string | undefined) ?? summary.oneLine,
        cached: true,
        skippedReason: "content_unchanged",
        fromAnalysisId: cached.id,
      })
    ),
    // `completeAnalysis`'s model is a plain string; a legacy cached row may
    // carry a null model, so only forward it when present.
    ...(cached.model ? { model: cached.model } : {}),
    tokensUsed: 0,
    durationMs: 0,
    fencingToken: analysis.attempts,
  })
  if (!completed) {
    console.warn(`[worker] Lost lease for ${analysis.id}; cached repo summary result not persisted`)
  }
  console.log(
    `[worker] Reused cached repo_summary for ${ownerSummary.fullName} (content unchanged) — LLM skipped`,
  )
  return true
}

/**
 * P3 closed loop for a *running* task whose sourceSha went stale while it was
 * in flight (coordinator Fix 3). Once the old task finishes, this re-checks the
 * repository head exactly once: if it advanced past the snapshot this task ran
 * against, the newer snapshot is re-enqueued so it is not lost (the sync no
 * longer calls us again for unchanged repos). `queueChangedRepositoryAnalysis`
 * performs its own active/completed dedup, so this can never stack a second
 * pending row nor recurse — the follow-up only enqueues; it never claims or
 * executes a task.
 *
 * No-op for manual/legacy tasks. Entirely best-effort: a failed follow-up must
 * never fail an already-completed claim.
 */
async function maybeRefollowAfterCompletion(
  analysis: ClaimableAnalysis,
  ctx: ClaimContext,
): Promise<void> {
  if (!ctx.isAlive()) return
  const input = (analysis.input as Record<string, unknown> | null) ?? null
  if (!input || input.automatic !== true) return
  if (!analysis.repositoryId) return

  try {
    // Prove (without extending the leasing type) that THIS run's terminal
    // "completed" state was actually persisted by this fencing token: the row
    // must be completed carrying the claim-time attempts. A lost-lease / stale
    // worker (completeAnalysis returned false) finds nothing here and exits, so
    // it can never enqueue a follow-up side-effect.
    const completed = await prisma.analysis.findFirst({
      where: { id: analysis.id, status: "completed", attempts: analysis.attempts },
      select: { sourceSha: true },
    })
    if (!completed) return

    const repo = await prisma.repository.findUnique({
      where: { id: analysis.repositoryId },
      select: { headSha: true },
    })
    const completedSourceSha = completed.sourceSha ?? null
    if (!repo?.headSha || repo.headSha === completedSourceSha) return

    const { queueChangedRepositoryAnalysis } = await import(
      "@/services/analysis/auto-analysis.service"
    )
    const outcome = await queueChangedRepositoryAnalysis({
      repositoryId: analysis.repositoryId,
      userId: analysis.userId,
      sourceSha: repo.headSha,
      reason: "updated",
    })
    console.log(
      `[worker] Follow-up: re-enqueued ${analysis.analysisType} for head ${repo.headSha} ` +
        `(completed task ran at ${completedSourceSha ?? "null"}) -> queued=${outcome.queued} skipped=${outcome.skipped}`,
    )
  } catch (error) {
    // Never fail a completed claim because the follow-up check failed.
    console.warn(
      `[worker] Follow-up re-enqueue skipped for ${analysis.repositoryId}:`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Process a claimed analysis. `ctx` gates every write; once the claim is dead
 * the function stops launching writes and suppresses any late error it hits.
 * All terminal writes are fenced with the claim-time `attempts` token.
 */
async function processClaimed(analysis: ClaimableAnalysis, ctx: ClaimContext): Promise<void> {
  try {
    switch (analysis.analysisType) {
      case "repo_summary": {
        if (!analysis.repositoryId) {
          throw new Error("Missing repositoryId for repo_summary analysis")
        }

        const repo = await prisma.repository.findUnique({
          where: { id: analysis.repositoryId },
          select: {
            name: true,
            fullName: true,
            description: true,
            language: true,
            topics: true,
            stars: true,
            forks: true,
            url: true,
            defaultBranch: true,
            owner: true,
            userId: true,
          },
        })

        if (!repo) {
          throw new Error("Repository not found")
        }
        // fail-closed: never analyze (or produce assets for) a repo the
        // analysis owner does not own.
        assertOwnership(repo.userId, analysis.userId, analysis.id)

        // Only a genuine 404 means "no README". 403/429/5xx/network errors are
        // rethrown by fetchRepoReadme so the task fails (and retries) instead
        // of completing with a silently-missing README.
        const readme = await fetchRepoReadme(analysis.userId, repo.owner, repo.name)

        if (!ctx.isAlive()) throw new LeaseLostError()

        const input = (analysis.input as Record<string, unknown> | null) ?? {}
        const isAutomatic = input.automatic === true

        // P3: automatic tasks are deduplicated by content fingerprint before the
        // LLM is paid for. Manual/legacy tasks skip straight to the normal path.
        if (isAutomatic) {
          const reused = await maybeReuseCachedSummary(
            analysis,
            ctx,
            {
              name: repo.name,
              fullName: repo.fullName,
              description: repo.description,
              language: repo.language,
              topics: repo.topics,
              url: repo.url,
              defaultBranch: repo.defaultBranch,
            },
            readme,
            { fullName: repo.fullName },
          )
          if (reused) break
        }

        if (!ctx.isAlive()) throw new LeaseLostError()

        // The shared service persists the result conditionally with our lease
        // AND our fencing token.
        await analyzeRepoSummary(
          analysis.repositoryId,
          analysis.userId,
          {
            name: repo.name,
            fullName: repo.fullName,
            description: repo.description,
            language: repo.language,
            topics: repo.topics,
            stars: repo.stars,
            forks: repo.forks,
            url: repo.url,
            defaultBranch: repo.defaultBranch,
          },
          readme,
          {
            analysisId: analysis.id,
            workerId: WORKER_ID,
            fencingToken: analysis.attempts,
            canWrite: () => ctx.isAlive(),
          },
        )

        console.log(`[worker] Completed repo_summary for ${repo.fullName}`)
        break
      }

      case "asset_extraction": {
        if (!analysis.repositoryId) {
          throw new Error("Missing repositoryId for asset_extraction")
        }

        const repo = await prisma.repository.findUnique({
          where: { id: analysis.repositoryId },
          select: { owner: true, name: true, userId: true },
        })

        if (!repo) {
          throw new Error("Repository not found")
        }
        // fail-closed: never write assets for a repo the analysis owner does
        // not own.
        assertOwnership(repo.userId, analysis.userId, analysis.id)

        const input = (analysis.input as Record<string, unknown>) ?? {}
        const isAutomatic = input.automatic === true
        const result = await extractAssetsFromRepo(
          analysis.userId,
          analysis.repositoryId,
          repo.owner,
          repo.name,
          {
            maxFiles: (input.maxFiles as number) ?? 20,
            useLLM: (input.useLLM as boolean) ?? true,
            // P3: ONLY automatic tasks carry the sourceSha property — the
            // extraction layer uses its *presence* to recognize the
            // auto-incremental path (a null value still counts as automatic, so
            // an empty-repo fingerprint fallback is never treated as manual).
            // Manual/legacy tasks keep the historical options shape unchanged.
            ...(isAutomatic
              ? { sourceSha: typeof input.sourceSha === "string" ? input.sourceSha : null }
              : {}),
            // Stop the extraction loop on heartbeat loss so a stale worker can
            // not keep writing knowledge assets after losing the lease.
            isCancelled: () => !ctx.isAlive(),
          },
        )

        if (!ctx.isAlive()) throw new LeaseLostError()

        const completed = await completeAnalysis({
          analysisId: analysis.id,
          workerId: WORKER_ID,
          status: "completed",
          result: JSON.parse(JSON.stringify(result)),
          fencingToken: analysis.attempts,
        })
        if (!completed) {
          console.warn(`[worker] Lost lease for ${analysis.id}; asset extraction result not persisted`)
        }

        console.log(
          `[worker] Completed asset_extraction for ${repo.owner}/${repo.name}: ${result.extracted} extracted, ${result.skipped} skipped`,
        )
        break
      }

      default:
        throw new Error(`Unsupported analysis type: ${analysis.analysisType}`)
    }
  } catch (error) {
    if (!ctx.isAlive()) {
      // The claim is already dead (heartbeat loss, timeout, or reclaim). Do not
      // launch any further write; suppress the late error silently.
      return
    }
    throw error
  }
}

/**
 * Fully process one already-claimed analysis: heartbeat renewal on a timer,
 * hard timeout, and a fenced terminal update. Returns `true` when the run
 * ended without needing to release the task back for retry (i.e. it completed
 * or the claim was already dead), `false` when it had to fail the task.
 */
export async function runClaimed(analysis: ClaimableAnalysis): Promise<boolean> {
  const ctx = createContext(analysis.id)
  const fencingToken = analysis.attempts
  const timeoutMs = taskTimeoutMs()

  // Renew the lease on a schedule well under the lease duration. A renewal
  // that returns false means the lease is gone (expired and reclaimed, fencing
  // no longer matches, or the row reached a terminal state): stop writing.
  const heartbeat = setInterval(() => {
    renewLease({ analysisId: analysis.id, workerId: WORKER_ID, fencingToken })
      .then((ok) => {
        if (!ok) {
          console.warn(`[worker] Heartbeat failed for ${analysis.id}; stopping subsequent writes`)
          ctx.cancel("heartbeat-lease-lost")
        }
      })
      .catch((err) => {
        // Fail closed on transport/database errors too: a worker that cannot
        // prove its lease is still valid must not keep producing writes.
        console.warn(`[worker] Heartbeat error for ${analysis.id}:`, (err as Error).message)
        ctx.cancel("heartbeat-renewal-error")
      })
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  try {
    await withTimeout(
      processClaimed(analysis, ctx),
      timeoutMs,
      () => ctx.cancel(`task-timeout-${timeoutMs}`),
      () => new TaskTimeoutError(analysis.id, timeoutMs),
    )
    await maybeRefollowAfterCompletion(analysis, ctx)
    return true
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error"
    console.error(`[worker] Failed analysis ${analysis.id}: ${errMsg}`)
    // Release the task for (bounded) retry, or terminally fail it once attempts
    // are exhausted. The write is conditional on the lease AND the fencing
    // token, so a stale worker can never persist a stale error.
    const persisted = await failAnalysis({
      analysisId: analysis.id,
      workerId: WORKER_ID,
      error: errMsg,
      // Preserve the duration measured by the shared LLM call when available so
      // a failed task still carries a meaningful durationMs.
      durationMs: error instanceof AnalysisError ? error.durationMs : undefined,
      // Ownership violations are permanent and must not be retried into more
      // executions. Other failures retain the normal bounded retry policy.
      maxAttempts: error instanceof OwnershipMismatchError ? analysis.attempts : undefined,
      fencingToken,
    })
    if (!persisted) {
      console.warn(`[worker] Lost lease before failing ${analysis.id}; stale error not persisted`)
    }
    return false
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * Claim the next task and dispatch its processing into the concurrency pool.
 * Returns `true` when a task was claimed+dispatched, `false` when the pool is
 * full or the queue is empty. The dispatched job runs in the background; await
 * `flushActive()` to wait for all in-flight jobs.
 */
export async function processOne(): Promise<boolean> {
  if (activeJobs.size >= MAX_CONCURRENT) return false

  // Atomically claim the next pending, no-lease, or lease-expired task.
  const analysis = await claimNextAnalysis({ workerId: WORKER_ID })
  if (!analysis) return false

  void trackClaim(analysis)
  return true
}

/** Start a background claim and keep it tracked in the pool until it settles. */
async function trackClaim(analysis: ClaimableAnalysis): Promise<void> {
  const job = runClaimed(analysis).then(
    () => {},
    () => {},
  )
  activeJobs.add(job)
  try {
    await job
  } finally {
    activeJobs.delete(job)
  }
}

/** Wait for every in-flight claim to settle. Used by tests and shutdown. */
export async function flushActive(): Promise<void> {
  await Promise.allSettled([...activeJobs])
}

async function waitForActiveSlot(): Promise<void> {
  if (activeJobs.size === 0) return
  await Promise.race([...activeJobs])
}

export async function main() {
  console.log("[worker] Analysis worker started")

  const shutdown = async () => {
    console.log("[worker] Shutting down...")
    await flushActive()
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  while (true) {
    try {
      // Fill the pool: keep claiming until it is full or the queue is drained.
      let claimed = false
      while (await processOne()) {
        claimed = true
      }

      if (activeJobs.size >= MAX_CONCURRENT) {
        // Pool is full; resume as soon as the first job settles.
        await waitForActiveSlot()
      } else if (!claimed) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
      // claimed && pool not full: loop immediately to keep filling the pool.
    } catch (error) {
      console.error("[worker] Error in main loop:", error)
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryUrl === import.meta.url) {
  main().catch(async (error) => {
    console.error("[worker] Fatal startup error:", error)
    await prisma.$disconnect()
    process.exit(1)
  })
}