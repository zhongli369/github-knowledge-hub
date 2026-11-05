import { prisma } from "@/lib/prisma"
import {
  getOwnedRepositoryMeta,
  REPOSITORY_NOT_OWNED_MESSAGE,
} from "./repository-ownership"

/** Error message returned when an enqueue target repository is missing/not owned. */
export const REPOSITORY_NOT_FOUND_ERROR = REPOSITORY_NOT_OWNED_MESSAGE

export interface EnqueueResult {
  analysisId: string
  /**
   * "error" is returned (never thrown) when the repository is missing or not
   * owned by the acting user — an illegal repositoryId is never enqueued.
   */
  status: "queued" | "already_completed" | "already_queued" | "error"
  error?: string
}

/** Prisma unique-constraint violation code (PostgreSQL 23505). */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002"
}

/**
 * Look up an active (pending / running) analysis of the given type for this
 * repository + user. Used by the pre-insert dedup and by the concurrent-winner
 * re-query after a unique-violation, so a loser maps to `already_queued`.
 *
 * Exported for the P3 auto-analysis enqueue path, which reuses the exact same
 * active-task dedup so automatic tasks never stack a second pending row on top
 * of a manual one (and vice versa).
 */
export async function findActiveAnalysis(
  repoId: string,
  userId: string,
  analysisType: string
): Promise<{ analysisId: string; status: "already_queued" } | null> {
  const active = await prisma.analysis.findFirst({
    where: {
      repositoryId: repoId,
      userId,
      analysisType,
      status: { in: ["pending", "running"] },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  })
  return active ? { analysisId: active.id, status: "already_queued" } : null
}

/**
 * Create a pending repo_summary analysis for the worker to pick up.
 *
 * Security boundary: the repository must exist and be owned by `userId`, or no
 * Analysis row is created. This also covers `enqueueBatchAction`, which routes
 * every repositoryId through here.
 *
 * Skips if a completed summary already exists or a pending/running one is
 * queued. The final `create` is raced against the active partial unique index
 * (`(repositoryId, userId, analysisType)` filtered to pending/running). Whoever
 * loses the race observes P2002 and resolves to `already_queued` of the winner,
 * so concurrent duplicate enqueues can never produce two pending rows.
 */
export async function enqueueRepoSummary(
  repoId: string,
  userId: string
): Promise<EnqueueResult> {
  // 0. Ownership gate — refuse to enqueue for an illegal repositoryId.
  const owned = await getOwnedRepositoryMeta(repoId, userId)
  if (!owned) {
    return { analysisId: "", status: "error", error: REPOSITORY_NOT_OWNED_MESSAGE }
  }

  // 1. Check if a completed summary already exists
  const completed = await prisma.analysis.findFirst({
    where: {
      repositoryId: repoId,
      userId,
      analysisType: "repo_summary",
      status: "completed",
    },
    select: { id: true },
  })

  if (completed) {
    return { analysisId: completed.id, status: "already_completed" }
  }

  // 2. Check if already queued (pending or running)
  const queued = await findActiveAnalysis(repoId, userId, "repo_summary")
  if (queued) {
    return queued
  }

  // 3. Create pending analysis record. Two concurrent enqueues can both pass the
  //    pre-checks; the partial unique index makes the duplicate insert fail and
  //    we resolve to the winner instead of creating a second pending row.
  try {
    const analysis = await prisma.analysis.create({
      data: {
        analysisType: "repo_summary",
        status: "pending",
        repositoryId: repoId,
        userId,
      },
    })

    return { analysisId: analysis.id, status: "queued" }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findActiveAnalysis(repoId, userId, "repo_summary")
      if (winner) return winner
    }
    throw error
  }
}

/**
 * Create a pending asset_extraction analysis for the worker to pick up.
 * Ownership gate and concurrent-dedup behave exactly like `enqueueRepoSummary`.
 */
export async function enqueueAssetExtraction(
  repoId: string,
  userId: string
): Promise<EnqueueResult> {
  // 0. Ownership gate — refuse to enqueue for an illegal repositoryId.
  const owned = await getOwnedRepositoryMeta(repoId, userId)
  if (!owned) {
    return { analysisId: "", status: "error", error: REPOSITORY_NOT_OWNED_MESSAGE }
  }

  // 1. Check if already queued (pending or running)
  const queued = await findActiveAnalysis(repoId, userId, "asset_extraction")
  if (queued) {
    return queued
  }

  try {
    const analysis = await prisma.analysis.create({
      data: {
        analysisType: "asset_extraction",
        status: "pending",
        input: { maxFiles: 20, useLLM: true },
        repositoryId: repoId,
        userId,
      },
    })

    return { analysisId: analysis.id, status: "queued" }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findActiveAnalysis(repoId, userId, "asset_extraction")
      if (winner) return winner
    }
    throw error
  }
}
