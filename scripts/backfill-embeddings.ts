/**
 * Backfill RepoEmbedding for repos that have completed repo_summary
 * but no entry in the RepoEmbedding table.
 *
 * Usage: npx tsx scripts/backfill-embeddings.ts
 */

import { PrismaClient } from "@prisma/client"
import { generateRepoEmbedding } from "../src/services/llm/repo-embedding.service"

const prisma = new PrismaClient()

async function main() {
  console.log("[backfill] Finding repos with completed summaries missing embeddings...")

  const repos = await prisma.repository.findMany({
    where: {
      analyses: {
        some: {
          analysisType: "repo_summary",
          status: "completed",
        },
      },
      repoEmbedding: null,
    },
    select: {
      id: true,
      fullName: true,
      userId: true,
    },
  })

  console.log(`[backfill] Found ${repos.length} repos to backfill`)

  let success = 0
  let failed = 0

  for (const repo of repos) {
    try {
      console.log(`[backfill] Processing: ${repo.fullName}`)
      const ok = await generateRepoEmbedding(repo.id, repo.userId)
      if (ok) {
        success++
        console.log(`[backfill]   OK`)
      } else {
        failed++
        console.log(`[backfill]   SKIPPED (no embedding text to generate)`)
      }
    } catch (error) {
      failed++
      const msg = error instanceof Error ? error.message : "Unknown error"
      console.error(`[backfill]   FAILED: ${msg}`)
    }
  }

  console.log(`\n[backfill] Done. ${success} succeeded, ${failed} failed`)
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err)
  prisma.$disconnect()
  process.exit(1)
})
