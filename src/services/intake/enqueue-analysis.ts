import { prisma } from "@/lib/prisma"

export interface EnqueueResult {
  analysisId: string
  status: "queued" | "already_completed" | "already_queued"
}

/**
 * Create a pending repo_summary analysis for the worker to pick up.
 * Skips if a completed summary already exists or a pending/running one is queued.
 */
export async function enqueueRepoSummary(
  repoId: string,
  userId: string
): Promise<EnqueueResult> {
  // 1. Check if completed summary already exists
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
  const queued = await prisma.analysis.findFirst({
    where: {
      repositoryId: repoId,
      userId,
      analysisType: "repo_summary",
      status: { in: ["pending", "running"] },
    },
    select: { id: true },
  })

  if (queued) {
    return { analysisId: queued.id, status: "already_queued" }
  }

  // 3. Create pending analysis record
  const analysis = await prisma.analysis.create({
    data: {
      analysisType: "repo_summary",
      status: "pending",
      repositoryId: repoId,
      userId,
    },
  })

  return { analysisId: analysis.id, status: "queued" }
}

export async function enqueueAssetExtraction(
  repoId: string,
  userId: string
): Promise<EnqueueResult> {
  // Check if already queued (pending or running)
  const queued = await prisma.analysis.findFirst({
    where: {
      repositoryId: repoId,
      userId,
      analysisType: "asset_extraction",
      status: { in: ["pending", "running"] },
    },
    select: { id: true },
  })

  if (queued) {
    return { analysisId: queued.id, status: "already_queued" }
  }

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
}
