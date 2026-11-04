/**
 * Background analysis worker (P1 Agent B).
 *
 * Usage: npm run worker
 *
 * Polls for claimable analyses and processes them via the LLM service. A task
 * is claimed atomically through PostgreSQL (FOR UPDATE SKIP LOCKED); the lease
 * is renewed by a heartbeat while a task is processed; terminal updates are
 * conditional on the worker still owning a valid lease so a stale worker can
 * never overwrite a newer worker's result.
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { prisma } from "@/lib/prisma"
import { analyzeRepoSummary, AnalysisError } from "@/services/llm/analysis.service"
import { extractAssetsFromRepo } from "@/services/knowledge/extraction.service"
import { createOctokit } from "@/lib/github/client"
import {
  claimNextAnalysis,
  completeAnalysis,
  failAnalysis,
  renewLease,
  createWorkerId,
  HEARTBEAT_INTERVAL_MS,
  type ClaimableAnalysis,
} from "@/services/analysis/leasing.service"

const POLL_INTERVAL_MS = 5_000
const MAX_CONCURRENT = 3

// Unique identity for this worker process. Overridable for tests/containers.
const WORKER_ID = process.env.WORKER_ID || createWorkerId()

let running = 0

async function processClaimed(analysis: ClaimableAnalysis): Promise<void> {
  console.log(`[worker] Processing analysis ${analysis.id} (${analysis.analysisType}) owned by ${WORKER_ID}`)

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
        },
      })

      if (!repo) {
        throw new Error("Repository not found")
      }

      // Token loading/decryption errors must fail the task explicitly. Only a
      // README request made with a valid token may fall back to no README.
      const octokit = await createOctokit(analysis.userId)
      let readme: string | null = null
      try {
        const { data } = await octokit.repos.getReadme({
          owner: repo.owner,
          repo: repo.name,
        })
        readme = Buffer.from(data.content, "base64").toString("utf-8")
      } catch {
        console.log(`[worker] No README found for ${repo.fullName}, continuing without`)
      }

      // The shared service persists the result conditionally with our lease.
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
        { analysisId: analysis.id, workerId: WORKER_ID }
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
        select: { owner: true, name: true },
      })

      if (!repo) {
        throw new Error("Repository not found")
      }

      const input = (analysis.input as Record<string, unknown>) ?? {}
      const result = await extractAssetsFromRepo(
        analysis.userId,
        analysis.repositoryId,
        repo.owner,
        repo.name,
        {
          maxFiles: (input.maxFiles as number) ?? 20,
          useLLM: (input.useLLM as boolean) ?? true,
        }
      )

      const completed = await completeAnalysis({
        analysisId: analysis.id,
        workerId: WORKER_ID,
        status: "completed",
        result: JSON.parse(JSON.stringify(result)),
      })
      if (!completed) {
        console.warn(`[worker] Lost lease for ${analysis.id}; asset extraction result not persisted`)
      }

      console.log(`[worker] Completed asset_extraction for ${repo.owner}/${repo.name}: ${result.extracted} extracted, ${result.skipped} skipped`)
      break
    }
    default:
      throw new Error(`Unsupported analysis type: ${analysis.analysisType}`)
  }
}

export async function processOne(): Promise<boolean> {
  if (running >= MAX_CONCURRENT) return false

  // Atomically claim the next pending or lease-expired task.
  const analysis = await claimNextAnalysis({ workerId: WORKER_ID })
  if (!analysis) return false

  running++

  // Renew the lease on a schedule well under the lease duration.
  const heartbeat = setInterval(() => {
    renewLease({ analysisId: analysis.id, workerId: WORKER_ID }).catch((err) => {
      console.warn(`[worker] Heartbeat failed for ${analysis.id}:`, (err as Error).message)
    })
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  try {
    await processClaimed(analysis)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error"
    console.error(`[worker] Failed analysis ${analysis.id}: ${errMsg}`)
    const persisted = await failAnalysis({
      analysisId: analysis.id,
      workerId: WORKER_ID,
      error: errMsg,
      // Preserve the duration measured by the shared LLM call when available so
      // a failed task still carries a meaningful durationMs.
      durationMs: error instanceof AnalysisError ? error.durationMs : undefined,
    })
    if (!persisted) {
      console.warn(`[worker] Lost lease before failing ${analysis.id}; stale error not persisted`)
    }
  } finally {
    clearInterval(heartbeat)
    running--
  }

  return true
}

export async function main() {
  console.log("[worker] Analysis worker started")

  const shutdown = async () => {
    console.log("[worker] Shutting down...")
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  while (true) {
    try {
      let processed = false
      while (await processOne()) {
        processed = true
      }
      if (!processed) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
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