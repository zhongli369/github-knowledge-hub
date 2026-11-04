/**
 * Backfill KnowledgeAsset.difficulty for legacy assets created before the
 * field was persisted.
 *
 * The summary column stores the raw JSON produced by analyzeCodePatterns, so we
 * re-parse and re-validate it. Rows produced by a failed LLM call carry the
 * fallback marker "LLM parse failed" and are skipped instead of being assigned a
 * fabricated difficulty.
 *
 * Usage:
 *   npx tsx scripts/backfill-asset-difficulty.ts            # dry-run only
 *   npx tsx scripts/backfill-asset-difficulty.ts --execute   # apply updates
 */

import { PrismaClient } from "@prisma/client"
import { parseCodeAnalysisResult } from "../src/services/knowledge/extraction.service"

const prisma = new PrismaClient()
const EXECUTE = process.argv.includes("--execute")

async function main() {
  console.log(
    `[backfill] Finding assets with NULL difficulty but a non-null summary${EXECUTE ? "" : " (DRY-RUN)"}...`,
  )

  const assets = await prisma.knowledgeAsset.findMany({
    where: {
      difficulty: null,
      summary: { not: null },
    },
    select: { id: true, title: true, summary: true },
  })

  console.log(`[backfill] Found ${assets.length} candidate assets`)

  let updated = 0
  let skipped = 0
  let failed = 0

  for (const asset of assets) {
    const summary = asset.summary!
    // Skip LLM-failure fallbacks so an old fabricated value is never re-applied.
    if (summary.includes("LLM parse failed")) {
      skipped++
      console.log(`[backfill]   SKIP (failed LLM result): ${asset.title}`)
      continue
    }

    const parsed = parseCodeAnalysisResult(summary)
    if (!parsed.difficulty) {
      skipped++
      console.log(`[backfill]   SKIP (no valid difficulty): ${asset.title}`)
      continue
    }

    if (EXECUTE) {
      try {
        await prisma.knowledgeAsset.update({
          where: { id: asset.id },
          data: { difficulty: parsed.difficulty },
        })
        updated++
        console.log(`[backfill]   OK (${parsed.difficulty}): ${asset.title}`)
      } catch (error) {
        failed++
        const msg = error instanceof Error ? error.message : "Unknown error"
        console.error(`[backfill]   FAILED: ${asset.title} — ${msg}`)
      }
    } else {
      updated++
      console.log(`[backfill]   WOULD UPDATE (${parsed.difficulty}): ${asset.title}`)
    }
  }

  console.log(
    `\n[backfill] Done (${EXECUTE ? "applied" : "dry-run"}). ` +
      `${updated} would/could update, ${skipped} skipped, ${failed} failed`,
  )
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err)
  prisma.$disconnect()
  process.exit(1)
})