"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { enqueueRepoSummary } from "@/services/intake"

export interface EnqueueActionResult {
  analysisId: string
  status: "queued" | "already_completed" | "already_queued"
  error?: string
}

export async function enqueueAnalysisAction(
  repoId: string
): Promise<EnqueueActionResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { analysisId: "", status: "queued", error: "Not authenticated" }
  }

  const result = await enqueueRepoSummary(repoId, session.user.id)
  revalidatePath("/library")
  revalidatePath(`/library/${repoId}`)
  return result
}

export async function enqueueBatchAction(
  repoIds: string[]
): Promise<{ results: EnqueueActionResult[] }> {
  const session = await auth()
  if (!session?.user?.id) {
    return { results: repoIds.map(() => ({ analysisId: "", status: "queued" as const, error: "Not authenticated" })) }
  }

  const results: EnqueueActionResult[] = []
  for (const repoId of repoIds) {
    const result = await enqueueRepoSummary(repoId, session.user.id)
    results.push(result)
  }

  revalidatePath("/library")
  return { results }
}
