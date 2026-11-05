#!/usr/bin/env node
/**
 * Automation scheduler worker (P3).
 *
 * Usage: npm run worker:automation
 *
 * Polls for due automation settings and runs the scheduled incremental sync
 * (trigger:"scheduled") for each. Lease ownership is managed by
 * @/services/automation/scheduler.service: claims are atomic (FOR UPDATE SKIP
 * LOCKED) so multiple workers can never double-run a user, and a lost lease
 * (pause / reclaim) turns the terminal release into a no-op.
 *
 * The automation worker deliberately processes one round at a time: a run
 * performs GitHub API work per changed repo, so serializing keeps rate-limit
 * pressure bounded. A failed round never crashes the process — the scheduler
 * service reschedules `nextSyncAt` on both success and failure, and the loop
 * simply sleeps until the next poll.
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { prisma } from "@/lib/prisma"
import {
  createWorkerId,
  leaseMs,
  pollIntervalMs,
  processDueSchedules,
  type ProcessDueSchedulesResult,
} from "@/services/automation/scheduler.service"

const WORKER_ID = process.env.WORKER_ID || createWorkerId()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function main(): Promise<void> {
  const pollMs = pollIntervalMs()
  const workerLabel = WORKER_ID.length > 24 ? `${WORKER_ID.slice(0, 24)}…` : WORKER_ID
  console.log(
    `[automation-worker] started (workerId=${workerLabel}, poll=${pollMs}ms, lease=${leaseMs()}ms)`,
  )

  let shuttingDown = false
  // The round currently in flight. On shutdown we first wait for it (and its
  // per-claim `finally`, which releases the lease and terminates the SyncRun)
  // so an interrupted worker never leaves a stuck `running` SyncRun, then we
  // disconnect — mirroring the analysis worker's `flushActive` semantics.
  let activeRound: Promise<ProcessDueSchedulesResult> | null = null

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log("[automation-worker] shutting down… (waiting for current round)")
    if (activeRound) {
      try {
        await activeRound
      } catch (error) {
        console.error("[automation-worker] interrupted round errored:", error)
      }
    }
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  while (!shuttingDown) {
    try {
      const round = processDueSchedules({ workerId: WORKER_ID })
      activeRound = round
      const result = await round
      activeRound = null
      if (result.error) {
        console.error(`[automation-worker] poll round error: ${result.error}`)
      }
      // claimed === 0: nothing due, wait for the next poll.
      if (result.claimed === 0) {
        await sleep(pollMs)
      } else {
        // A small politeness floor between draining batches.
        await sleep(250)
      }
    } catch (error) {
      console.error("[automation-worker] unexpected poll error:", error)
      await sleep(pollMs)
    }
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryUrl === import.meta.url) {
  main().catch(async (error) => {
    console.error("[automation-worker] fatal startup error:", error)
    await prisma.$disconnect()
    process.exit(1)
  })
}