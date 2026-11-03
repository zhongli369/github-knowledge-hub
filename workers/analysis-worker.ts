/**
 * Background analysis worker.
 *
 * Usage: npm run worker
 * Polls for "pending" analyses and processes them via the LLM service.
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { prisma } from "@/lib/prisma"
import { analyzeRepoSummary } from "@/services/llm/analysis.service"
import { extractAssetsFromRepo } from "@/services/knowledge/extraction.service"
import { createOctokit } from "@/lib/github/client"

const POLL_INTERVAL_MS = 5_000
const MAX_CONCURRENT = 3

let running = 0

export async function processOne(): Promise<boolean> {
  if (running >= MAX_CONCURRENT) return false

  // Claim a pending analysis. Atomic multi-worker claiming is tracked separately.
  const analysis = await prisma.analysis.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  })

  if (!analysis) return false

  running++

  try {
    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { status: "running" },
    })

    console.log(`[worker] Processing analysis ${analysis.id} (${analysis.analysisType})`)

    switch (analysis.analysisType) {
      case "repo_summary": {
        if (!analysis.repositoryId) {
          await prisma.analysis.update({
            where: { id: analysis.id },
            data: {
              status: "failed",
              error: "Missing repositoryId for repo_summary analysis",
            },
          })
          break
        }

        // Get repo metadata from DB
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
          await prisma.analysis.update({
            where: { id: analysis.id },
            data: {
              status: "failed",
              error: "Repository not found",
            },
          })
          break
        }

        // Fetch README via GitHub API
        let readme: string | null = null
        try {
          const octokit = await createOctokit(analysis.userId)
          const { data } = await octokit.repos.getReadme({
            owner: repo.owner,
            repo: repo.name,
          })
          readme = Buffer.from(data.content, "base64").toString("utf-8")
        } catch {
          console.log(`[worker] No README found for ${repo.fullName}, continuing without`)
        }

        // Process via shared LLM service, reusing the claimed analysis record
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
          { analysisId: analysis.id }
        )

        console.log(`[worker] Completed repo_summary for ${repo.fullName}`)
        break
      }
      case "asset_extraction": {
        if (!analysis.repositoryId) {
          await prisma.analysis.update({
            where: { id: analysis.id },
            data: { status: "failed", error: "Missing repositoryId for asset_extraction" },
          })
          break
        }

        const repo = await prisma.repository.findUnique({
          where: { id: analysis.repositoryId },
          select: { owner: true, name: true },
        })

        if (!repo) {
          await prisma.analysis.update({
            where: { id: analysis.id },
            data: { status: "failed", error: "Repository not found" },
          })
          break
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

        await prisma.analysis.update({
          where: { id: analysis.id },
          data: {
            status: "completed",
            result: JSON.parse(JSON.stringify(result)),
          },
        })

        console.log(`[worker] Completed asset_extraction for ${repo.owner}/${repo.name}: ${result.extracted} extracted, ${result.skipped} skipped`)
        break
      }
      default: {
        await prisma.analysis.update({
          where: { id: analysis.id },
          data: {
            status: "failed",
            error: `Unsupported analysis type: ${analysis.analysisType}`,
          },
        })
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error"
    console.error(`[worker] Failed analysis ${analysis.id}: ${errMsg}`)
    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { status: "failed", error: errMsg.slice(0, 1000) },
    })
  } finally {
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
