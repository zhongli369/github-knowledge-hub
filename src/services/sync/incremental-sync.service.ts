/**
 * Incremental starred-repository sync (P3, Agent: Prisma schema + sync).
 *
 * Pulls the authenticated user's current starred repositories and classifies
 * each tracked row as one of:
 *
 *   added     - not tracked before (newly starred repo / first run)
 *   updated   - re-starred, pushedAt changed (content), or metadata changed
 *   unchanged - only star/forks counts or nothing moved
 *   unstarred - tracked in a previous run but absent from the current star list
 *
 * Knowledge assets are never deleted here. Unstarring a repository only sets
 * `unstarredAt`; re-starring clears it again.
 *
 * API budget guard: the starred list response carries `pushedAt`, so the run
 * only calls GET /repos/{owner}/{repo}/branches/{branch} (via
 * `fetchRepositoryHeadSha`) for NEW / re-starred / pushedAt-changed / legacy
 * headless repos (first-time HEAD capture). An unchanged repo is never
 * individually fetched, and stars/forks churn is persisted without triggering
 * any per-repo API call or AI analysis.
 *
 * AI integration: when `autoAnalyze` is on, changed repos are handed to
 * `queueChangedRepositoryAnalysis` (@/services/analysis/auto-analysis.service,
 * owned by the AI agent). This module never calls an LLM itself.
 */

import { createHash } from "node:crypto"
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import {
  fetchRepositoryHeadSha,
  fetchStarredRepos,
  type GitHubRepo,
} from "@/services/github/repos.service"
// Exact contract with the AI agent:
//   queueChangedRepositoryAnalysis(input: {
//     repositoryId: string; userId: string; sourceSha: string | null;
//     reason: "new" | "updated" | "restarred"
//   }): Promise<{ queued: number; skipped: number }>
import { queueChangedRepositoryAnalysis } from "@/services/analysis/auto-analysis.service"

const MAX_ERROR_LENGTH = 2000

export const SYNC_RUN_IN_PROGRESS_MESSAGE =
  "A sync run is already in progress for this user"

/**
 * A `running` SyncRun whose `updatedAt` has not advanced past this fixed cutoff
 * is considered crashed (the process died mid-run, so no further progress bumps
 * will refresh `updatedAt`). Reaping it lets a later run recover instead of
 * being permanently blocked. Live runs keep their `updatedAt` fresh via every
 * `syncRun.update` progress bump (`@updatedAt`), so they are never touched.
 */
export const SYNC_RUN_STALE_TIMEOUT_MS = 30 * 60 * 1000

/** Error stamped on a reaped (recovered) run that appeared stuck. */
export const SYNC_RUN_TIMED_OUT_MESSAGE = "Sync run timed out"

/** Thrown when the user already has a running SyncRun (friendly concurrency error). */
export class SyncRunInProgressError extends Error {
  constructor(message: string = SYNC_RUN_IN_PROGRESS_MESSAGE) {
    super(message)
    this.name = "SyncRunInProgressError"
  }
}

export interface SyncRunSummary {
  runId: string
  status: "completed" | "failed"
  totalCount: number
  processedCount: number
  addedCount: number
  updatedCount: number
  unchangedCount: number
  unstarredCount: number
  failedCount: number
  analysisQueuedCount: number
}

export interface SyncRunInput {
  userId: string
  trigger: "manual" | "scheduled"
  autoAnalyze?: boolean
  /** Injectable clock for tests; defaults to new Date(). */
  now?: Date
}

interface ExistingRepositoryRow {
  id: string
  githubId: number
  owner: string
  name: string
  fullName: string
  url: string
  description: string | null
  language: string | null
  homepage: string | null
  defaultBranch: string
  isArchived: boolean
  isTemplate: boolean
  license: string | null
  size: number
  topics: string[]
  headSha: string | null
  syncHash: string | null
  pushedAt: Date | null
  starredAt: Date | null
  unstarredAt: Date | null
}

type RunCategory = "added" | "updated" | "unchanged"
type AnalysisReason = "new" | "updated" | "restarred"

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002"
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, MAX_ERROR_LENGTH)
}

/**
 * Collapse per-repo failures into a bounded, non-token-bearing message. Null
 * when every repository succeeded, so a clean run keeps `error` empty.
 */
function summarizeRepoErrors(errors: string[]): string | null {
  if (errors.length === 0) return null
  const shown = errors
    .slice(0, 5)
    .map((message) => message.slice(0, 200))
  const rest = errors.length - shown.length
  const suffix = rest > 0 ? ` (and ${rest} more repo errors)` : ""
  return shown.join(" | ").concat(suffix).slice(0, MAX_ERROR_LENGTH)
}

function sameDate(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.getTime() === b.getTime()
}

function sortedTopicsSignature(topics: string[]): string {
  return [...topics].sort().join("\u0000")
}

/**
 * Stable, deterministic content fingerprint for a GitHub repository.
 *
 * Hashes the structural / content-bearing fields only, so per-run count churn
 * (stars/forks) and heartbeat fields (lastFetchedAt) can never change it. The
 * sync only recomputes it when the default-branch HEAD is refreshed (new /
 * re-starred / pushedAt changed), so metadata-only edits leave it stable.
 *
 * Exports a path whose exact set of excluded fields ("no stars/forks/
 * lastFetchedAt") the run depends on.
 */
export function createRepositorySyncHash(repo: GitHubRepo): string {
  const parts = [
    repo.fullName,
    repo.description ?? "",
    repo.homepage ?? "",
    repo.language ?? "",
    repo.license ?? "",
    repo.defaultBranch,
    String(repo.size),
    String(repo.isArchived),
    String(repo.isTemplate),
    sortedTopicsSignature(repo.topics),
    repo.pushedAt ?? "",
  ]
  return createHash("sha256").update(parts.join("\u0001")).digest("hex")
}

/**
 * Decide whether the default-branch HEAD must be fetched for a repo.
 *
 * True when the repo is new, was re-starred since the last sync (unstarredAt
 * set), or its `pushedAt` moved. Purely-metadata updates and star/forks churn
 * keep the persisted HEAD — no per-repo GitHub call.
 */
export function shouldFetchRepositoryHead(
  existing: {
    headSha: string | null
    pushedAt: Date | null
    unstarredAt: Date | null
  } | null,
  incoming: GitHubRepo
): boolean {
  if (!existing) return true
  if (existing.unstarredAt !== null) return true
  // Pre-P3 rows (P2 sync, or a run that crashed before storing HEAD) have no
  // headSha yet. Even with an unchanged pushedAt, the HEAD is unknowable, so it
  // must be fetched once to initialize the row (and its content fingerprint).
  if (existing.headSha === null) return true
  const incomingPushedAt = incoming.pushedAt ? new Date(incoming.pushedAt) : null
  return !sameDate(existing.pushedAt, incomingPushedAt)
}

function metadataChanged(existing: ExistingRepositoryRow, repo: GitHubRepo): boolean {
  // Identity fields are included so a GitHub rename/transfer still counts as an
  // update (and its owner/name/fullName/url are persisted) instead of being
  // dropped by the fullName-based match.
  return (
    existing.owner !== repo.owner ||
    existing.name !== repo.name ||
    existing.fullName !== repo.fullName ||
    existing.url !== repo.url ||
    existing.description !== (repo.description ?? null) ||
    existing.language !== (repo.language ?? null) ||
    existing.homepage !== (repo.homepage ?? null) ||
    existing.defaultBranch !== repo.defaultBranch ||
    existing.isArchived !== repo.isArchived ||
    existing.isTemplate !== repo.isTemplate ||
    existing.license !== (repo.license ?? null) ||
    existing.size !== repo.size ||
    sortedTopicsSignature(existing.topics) !== sortedTopicsSignature(repo.topics)
  )
}

/** Fetch the default-branch HEAD SHA unless the repo has no commits (pushedAt null). */
async function maybeFetchHead(userId: string, repo: GitHubRepo): Promise<string | null> {
  if (!repo.pushedAt) return null
  return fetchRepositoryHeadSha(userId, repo.owner, repo.name, repo.defaultBranch)
}

async function maybeQueueAnalysis(options: {
  repositoryId: string
  userId: string
  sourceSha: string | null
  reason: AnalysisReason
  autoAnalyze: boolean
}): Promise<number> {
  if (!options.autoAnalyze) return 0
  const { queued } = await queueChangedRepositoryAnalysis({
    repositoryId: options.repositoryId,
    userId: options.userId,
    sourceSha: options.sourceSha,
    reason: options.reason,
  })
  return queued
}

interface ProcessOutcome {
  category: RunCategory
  analysisQueued: number
}

/**
 * Persist one incoming starred repo and classify it. Throws on any repo-scoped
 * failure (e.g. per-repo GitHub 403/5xx) so the caller can continue.
 */
async function processRepository(
  userId: string,
  repo: GitHubRepo,
  existing: ExistingRepositoryRow | null,
  now: Date,
  autoAnalyze: boolean
): Promise<ProcessOutcome> {
  const pushedAt = repo.pushedAt ? new Date(repo.pushedAt) : null

  // Newly tracked repo.
  if (!existing) {
    const headSha = await maybeFetchHead(userId, repo)
    const syncHash = createRepositorySyncHash(repo)
    const created = await prisma.repository.create({
      data: {
        githubId: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        description: repo.description,
        url: repo.url,
        homepage: repo.homepage,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        topics: repo.topics,
        defaultBranch: repo.defaultBranch,
        isArchived: repo.isArchived,
        isTemplate: repo.isTemplate,
        license: repo.license,
        size: repo.size,
        pushedAt,
        headSha,
        syncHash,
        starredAt: repo.starredAt ? new Date(repo.starredAt) : now,
        unstarredAt: null,
        lastFetchedAt: now,
        status: "new",
        userId,
      },
    })
    const analysisQueued = await maybeQueueAnalysis({
      repositoryId: created.id,
      userId,
      sourceSha: headSha,
      reason: "new",
      autoAnalyze,
    })
    return { category: "added", analysisQueued }
  }

  // Shared identity+metadata payload. Identity fields are persisted on every
  // update branch so a GitHub rename/transfer is reflected in the row instead of
  // being silently dropped by the fullName/githubId match.
  const identityAndMetadata: Prisma.RepositoryUpdateInput = {
    githubId: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    url: repo.url,
    homepage: repo.homepage,
    description: repo.description,
    language: repo.language,
    stars: repo.stars,
    forks: repo.forks,
    topics: repo.topics,
    defaultBranch: repo.defaultBranch,
    isArchived: repo.isArchived,
    isTemplate: repo.isTemplate,
    license: repo.license,
    size: repo.size,
  }

  // Re-starred: revive the row, refresh HEAD + fingerprint, queue analysis.
  if (existing.unstarredAt !== null) {
    const headSha = await maybeFetchHead(userId, repo)
    const syncHash = createRepositorySyncHash(repo)
    await prisma.repository.update({
      where: { id: existing.id },
      data: {
        ...identityAndMetadata,
        pushedAt,
        headSha,
        syncHash,
        starredAt: repo.starredAt ? new Date(repo.starredAt) : now,
        unstarredAt: null,
        lastFetchedAt: now,
      },
    })
    const analysisQueued = await maybeQueueAnalysis({
      repositoryId: existing.id,
      userId,
      sourceSha: headSha,
      reason: "restarred",
      autoAnalyze,
    })
    return { category: "updated", analysisQueued }
  }

  // Content-change signals for a non-re-starred row.
  const pushedAtChanged = !sameDate(existing.pushedAt, pushedAt)
  // Pre-P3 legacy row with real pushed content but no recorded HEAD: initialize
  // it once so it gets a headSha/syncHash/starredAt and joins auto-analysis.
  const legacyInit =
    existing.headSha === null &&
    existing.pushedAt !== null &&
    !pushedAtChanged

  // pushedAt moved, or a legacy row awaiting its first HEAD: refresh the
  // default-branch HEAD + fingerprint, then queue analysis. This is the same
  // predicate the tests exercise (`shouldFetchRepositoryHead` returns true for
  // new, re-starred, pushedAt-changed and headSha-null rows).
  if (pushedAtChanged || legacyInit) {
    const headSha = await maybeFetchHead(userId, repo)
    const syncHash = createRepositorySyncHash(repo)
    await prisma.repository.update({
      where: { id: existing.id },
      data: {
        ...identityAndMetadata,
        pushedAt,
        headSha,
        syncHash,
        ...(legacyInit
          ? {
              starredAt:
                existing.starredAt ??
                (repo.starredAt ? new Date(repo.starredAt) : now),
            }
          : {}),
        lastFetchedAt: now,
      },
    })
    const analysisQueued = await maybeQueueAnalysis({
      repositoryId: existing.id,
      userId,
      sourceSha: headSha,
      reason: "updated",
      autoAnalyze,
    })
    return { category: "updated", analysisQueued }
  }

  // Metadata-only update: persist new fields, no HEAD fetch, no analysis.
  if (metadataChanged(existing, repo)) {
    await prisma.repository.update({
      where: { id: existing.id },
      data: { ...identityAndMetadata, lastFetchedAt: now },
    })
    return { category: "updated", analysisQueued: 0 }
  }

  // Nothing content/metadata-worthy moved: refresh star/forks counts + heartbeat.
  await prisma.repository.update({
    where: { id: existing.id },
    data: { stars: repo.stars, forks: repo.forks, lastFetchedAt: now },
  })
  return { category: "unchanged", analysisQueued: 0 }
}

interface RunPatch {
  totalCount?: number
  processedCount?: number
  addedCount?: number
  updatedCount?: number
  unchangedCount?: number
  unstarredCount?: number
  failedCount?: number
  analysisQueuedCount?: number
}

async function bumpRun(runId: string, patch: RunPatch): Promise<void> {
  const data: Prisma.SyncRunUpdateInput = {}
  if (patch.totalCount !== undefined) data.totalCount = patch.totalCount
  if (patch.processedCount !== undefined) data.processedCount = { increment: patch.processedCount }
  if (patch.addedCount !== undefined) data.addedCount = { increment: patch.addedCount }
  if (patch.updatedCount !== undefined) data.updatedCount = { increment: patch.updatedCount }
  if (patch.unchangedCount !== undefined) data.unchangedCount = { increment: patch.unchangedCount }
  if (patch.unstarredCount !== undefined) data.unstarredCount = { increment: patch.unstarredCount }
  if (patch.failedCount !== undefined) data.failedCount = { increment: patch.failedCount }
  if (patch.analysisQueuedCount !== undefined) data.analysisQueuedCount = { increment: patch.analysisQueuedCount }
  await prisma.syncRun.update({ where: { id: runId }, data })
}

async function createRunOrReject(userId: string, trigger: string, now: Date) {
  // Crash recovery: a process killed mid-run leaves a stale `running` row whose
  // updatedAt stops being refreshed. Conditionally mark such rows `failed` before
  // the active pre-check, so a dead run can never permanently block later runs.
  // The updatedAt filter (older than the fixed cutoff) keeps genuinely-active
  // long runs out of scope — every per-repo progress bump refreshes updatedAt.
  await prisma.syncRun.updateMany({
    where: {
      userId,
      status: "running",
      updatedAt: { lt: new Date(now.getTime() - SYNC_RUN_STALE_TIMEOUT_MS) },
    },
    data: { status: "failed", error: SYNC_RUN_TIMED_OUT_MESSAGE, finishedAt: now },
  })

  // Friendly pre-check; the partial unique index is the real concurrency guard.
  const active = await prisma.syncRun.findFirst({
    where: { userId, status: "running" },
    select: { id: true },
  })
  if (active) throw new SyncRunInProgressError()

  try {
    return await prisma.syncRun.create({
      data: {
        userId,
        trigger,
        status: "running",
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new SyncRunInProgressError()
    throw error
  }
}

/**
 * Run one incremental starred-repo sync for a user.
 *
 * Creates a running SyncRun, pulls the starred list, classifies every tracked
 * repository, persists per-repo progress counters as it goes, and writes the
 * terminal state (status + finishedAt) on success. Any global failure (starred
 * list fetch, database outage) is written to the run as `failed` + `error` and
 * re-thrown; per-repo failures increment `failedCount` and processing continues.
 */
export async function runUserSync(input: SyncRunInput): Promise<SyncRunSummary> {
  const { userId, trigger } = input
  const now = input.now ?? new Date()
  const autoAnalyze = input.autoAnalyze ?? true

  const run = await createRunOrReject(userId, trigger, now)

  try {
    const incoming = await fetchStarredRepos(userId)

    const existingRows: ExistingRepositoryRow[] = await prisma.repository.findMany({
      where: { userId },
      select: {
        id: true,
        githubId: true,
        owner: true,
        name: true,
        fullName: true,
        url: true,
        description: true,
        language: true,
        homepage: true,
        defaultBranch: true,
        isArchived: true,
        isTemplate: true,
        license: true,
        size: true,
        topics: true,
        headSha: true,
        syncHash: true,
        pushedAt: true,
        starredAt: true,
        unstarredAt: true,
      },
    })

    const byGithubId = new Map<number, ExistingRepositoryRow>()
    const byFullName = new Map<string, ExistingRepositoryRow>()
    for (const row of existingRows) {
      byGithubId.set(row.githubId, row)
      byFullName.set(row.fullName, row)
    }

    // Authoritative current-star signal is the GitHub repo id. fullName is only a
    // legacy fallback (same fullName can belong to a different id if our stored
    // row predates a visible id), so a plain rename/transfer never unstars a repo.
    const incomingGithubIds = new Set(incoming.map((r) => r.id))
    const incomingFullNames = new Set(incoming.map((r) => r.fullName))
    const newlyUnstarred = existingRows.filter(
      (row) =>
        row.unstarredAt === null &&
        !incomingGithubIds.has(row.githubId) &&
        !incomingFullNames.has(row.fullName)
    )

    // Rows that were already unstarred in an earlier run are not re-processed.
    // totalCount = this run's scope: current stars + newly discovered unstars.
    const counters = {
      totalCount: incoming.length + newlyUnstarred.length,
      processedCount: 0,
      addedCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      unstarredCount: 0,
      failedCount: 0,
      analysisQueuedCount: 0,
    }
    const repoErrors: string[] = []
    await bumpRun(run.id, { totalCount: counters.totalCount })

    for (const repo of incoming) {
      try {
        const existing = byGithubId.get(repo.id) ?? byFullName.get(repo.fullName) ?? null
        const outcome = await processRepository(userId, repo, existing, now, autoAnalyze)
        counters.processedCount += 1
        if (outcome.category === "added") counters.addedCount += 1
        else if (outcome.category === "updated") counters.updatedCount += 1
        else counters.unchangedCount += 1
        counters.analysisQueuedCount += outcome.analysisQueued
        await bumpRun(run.id, {
          processedCount: 1,
          ...(outcome.category === "added" ? { addedCount: 1 } : {}),
          ...(outcome.category === "updated" ? { updatedCount: 1 } : {}),
          ...(outcome.category === "unchanged" ? { unchangedCount: 1 } : {}),
          ...(outcome.analysisQueued > 0 ? { analysisQueuedCount: outcome.analysisQueued } : {}),
        })
      } catch (error) {
        counters.processedCount += 1
        counters.failedCount += 1
        repoErrors.push(truncateError(error))
        await bumpRun(run.id, { processedCount: 1, failedCount: 1 })
      }
    }

    for (const row of newlyUnstarred) {
      try {
        // Unstarring never deletes knowledge assets; it only marks the star end.
        await prisma.repository.update({
          where: { id: row.id },
          data: { unstarredAt: now, lastFetchedAt: now },
        })
        counters.processedCount += 1
        counters.unstarredCount += 1
        await bumpRun(run.id, { processedCount: 1, unstarredCount: 1 })
      } catch (error) {
        counters.processedCount += 1
        counters.failedCount += 1
        repoErrors.push(truncateError(error))
        await bumpRun(run.id, { processedCount: 1, failedCount: 1 })
      }
    }

    // finishedAt is the REAL completion wall-clock (not the run start `now`)
    // so the UI shows an honest sync duration. Per-repo failures are aggregated
    // into `error` even when the run completed, and never leak tokens.
    const finishedAt = new Date()
    const aggregatedError = summarizeRepoErrors(repoErrors)
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "completed", finishedAt, error: aggregatedError },
    })

    return {
      runId: run.id,
      status: "completed",
      totalCount: counters.totalCount,
      processedCount: counters.processedCount,
      addedCount: counters.addedCount,
      updatedCount: counters.updatedCount,
      unchangedCount: counters.unchangedCount,
      unstarredCount: counters.unstarredCount,
      failedCount: counters.failedCount,
      analysisQueuedCount: counters.analysisQueuedCount,
    }
  } catch (error) {
    // Real completion time on the failure path too, so a failed run also shows
    // an honest duration.
    const finishedAt = new Date()
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "failed", error: truncateError(error), finishedAt },
    })
    throw error
  }
}