"use server"

import { auth } from "@/auth"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { enqueueRepoClassification } from "@/services/intake"

export type ClassificationMode = "all" | "unclassified" | "reclassify"

const CLASSIFICATION_MODES: readonly ClassificationMode[] = ["all", "unclassified", "reclassify"]

const NOT_AUTHENTICATED_ERROR = "Not authenticated"

async function requireUserId(): Promise<string> {
  const session = await auth()
  if (!session?.user?.id) throw new Error(NOT_AUTHENTICATED_ERROR)
  return session.user.id
}

/**
 * Queue auto-classification for the current user's repositories.
 *
 * All operations are scoped to the authenticated session's userId; the mode is
 * whitelisted. Duplicate pending/running tasks for the same (user, repo) are
 * prevented by the queue's active partial unique index (a second call returns
 * the in-flight job as "already_queued", counted as skipped here).
 *
 * Returned numbers are plain serializable primitives.
 *
 *   * "all"         -> every repository is queued; the worker skips unchanged
 *                      content via Agent A's hash check (no duplicate AI).
 *   * "unclassified"-> only repositories without a current "classified" result
 *                      are queued.
 *   * "reclassify"  -> every repository is queued with `force: true`.
 */
export async function startClassificationBatch(
  mode: ClassificationMode
): Promise<{ enqueued: number; skipped: number; total: number }> {
  const userId = await requireUserId()
  if (!CLASSIFICATION_MODES.includes(mode)) {
    throw new Error("Invalid classification mode")
  }

  const repos = await prisma.repository.findMany({
    where: { userId },
    select: { id: true },
  })

  let candidates = repos
  if (mode === "unclassified") {
    const classified = await prisma.repositoryClassification.findMany({
      where: { userId, repositoryId: { in: repos.map((r) => r.id) }, status: "classified" },
      select: { repositoryId: true },
    })
    const classifiedIds = new Set(classified.map((c) => c.repositoryId))
    candidates = repos.filter((r) => !classifiedIds.has(r.id))
  }

  let enqueued = 0
  let skipped = 0
  const batchId = randomUUID()
  for (const repo of candidates) {
    const result = await enqueueRepoClassification(repo.id, userId, {
      mode,
      force: mode === "reclassify",
      batchId,
    })
    if (result.status === "queued") enqueued++
    else skipped++ // already_queued / already-classified (unclassified) / error
  }

  return { enqueued, skipped, total: candidates.length }
}

/**
 * Progress of the current user's `repo_classification` jobs.
 *
 * Counts are scoped to the authenticated session's userId (never across users)
 * and to the newest manually-started batch. Older jobs without a batchId (for
 * example the initial migration batch or automatic sync jobs) remain visible as
 * one legacy progress view until the first manual batch is started.
 *
 * `total/pending/running/completed/failed` are Analysis-row counts in that
 * batch; `succeeded` and `skipped` come from completed job outcomes:
 *   * result.status === "classified"                         -> succeeded
 *   * result.status === "skipped" | "unclassified"           -> skipped
 *
 * Returns serializable numbers only.
 */
export async function getClassificationProgress(): Promise<{
  total: number
  pending: number
  running: number
  completed: number
  failed: number
  succeeded: number
  skipped: number
}> {
  const userId = await requireUserId()

  const batchRows = await prisma.analysis.findMany({
    where: { userId, analysisType: "repo_classification" },
    select: { input: true },
    orderBy: { createdAt: "desc" },
  })
  const latestBatchId = batchRows
    .map((row) => (row.input as { batchId?: unknown } | null)?.batchId)
    .find((value): value is string => typeof value === "string" && value.length > 0)
  const base = {
    userId,
    analysisType: "repo_classification" as const,
    ...(latestBatchId
      ? { input: { path: ["batchId"], equals: latestBatchId } }
      : {}),
  }

  const [total, pending, running, completed, failed, completedRows] = await Promise.all([
    prisma.analysis.count({ where: base }),
    prisma.analysis.count({ where: { ...base, status: "pending" } }),
    prisma.analysis.count({ where: { ...base, status: "running" } }),
    prisma.analysis.count({ where: { ...base, status: "completed" } }),
    prisma.analysis.count({ where: { ...base, status: "failed" } }),
    prisma.analysis.findMany({
      where: { ...base, status: "completed" },
      select: { repositoryId: true, result: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  let succeeded = 0
  let skipped = 0
  const seen = new Set<string>()
  for (const row of completedRows) {
    if (!row.repositoryId || seen.has(row.repositoryId)) continue
    seen.add(row.repositoryId)
    const status = (row.result as { status?: string } | null)?.status
    if (status === "classified") succeeded++
    else if (status === "skipped" || status === "unclassified") skipped++
  }

  return { total, pending, running, completed, failed, succeeded, skipped }
}