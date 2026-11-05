/**
 * Automation scheduler service (P3).
 *
 * Claims due automation settings and runs the scheduled sync for each. The
 * claim path mirrors the analysis worker's lease pattern but is simpler: there
 * is no per-task `attempts` fencing token, so ownership is fenced on
 * `workerId` + a not-yet-expired lease.
 *
 *   * `claimDueSettings` atomically leases the oldest enabled settings whose
 *     `nextSyncAt` is in the past and whose lease is missing or expired
 *     (`FOR UPDATE SKIP LOCKED`), writing the claimer's `workerId` + a new
 *     `leaseExpiresAt` so a second worker can never lease the same row.
 *   * `runClaimedSetting` calls the shared `runUserSync(trigger:"scheduled")`
 *     (owned by the sync Agent), which writes and terminates the SyncRun row
 *     itself. Global failures are recorded there and re-thrown; per-repo
 *     failures are counted by the sync service and complete the run.
 *   * `releaseSettingsLease` (in `finally`) clears the lease and advances
 *     `nextSyncAt` — but only while the claimer still owns the row. Pausing the
 *     automation or a reclaimed lease therefore turns the release into a
 *     no-op, so the next sync is not scheduled.
 *
 * A busy/noisy worker never crashes the process: `processDueSchedules` returns
 * every outcome and reschedules (`nextSyncAt = now + interval`) on both success
 * and failure.
 */

import os from "node:os"
import crypto from "node:crypto"
import {
  runUserSync,
  SyncRunInProgressError,
} from "@/services/sync/incremental-sync.service"
import { automationPrisma } from "./automation.db"
import { computeNextSyncAt } from "./policy"

/** Default scheduler poll cadence. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000
/** Hard floor for the poll interval; prevents pathological busy loops. */
export const MIN_POLL_INTERVAL_MS = 1_000

/** Default lease duration for one scheduled sync run. */
export const DEFAULT_LEASE_MS = 15 * 60_000
/** Hard floor for the lease duration. */
export const MIN_LEASE_MS = 60_000

/** Claim only the row being processed so queued claims cannot outlive their leases. */
export const CLAIM_BATCH_SIZE = 1

export interface ClaimedSettings {
  id: string
  userId: string
  autoAnalyze: boolean
  intervalMinutes: number
  nextSyncAt: Date
}

export interface ProcessedClaim {
  userId: string
  ok: boolean
  status?: string
  error?: string
}

export interface ProcessDueSchedulesResult {
  claimed: number
  processed: ProcessedClaim[]
  error?: string
}

interface RawClaimRow {
  id: string
  userId: string
  autoAnalyze: boolean
  intervalMinutes: number
  nextSyncAt: Date
}

/** Create a stable, per-process worker identity. */
export function createWorkerId(): string {
  return `automation:${os.hostname()}:${process.pid}:${crypto.randomUUID()}`
}

/** Read + validate the scheduler poll interval from the environment. */
export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTOMATION_POLL_INTERVAL_MS
  if (raw === undefined) return DEFAULT_POLL_INTERVAL_MS
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`AUTOMATION_POLL_INTERVAL_MS must be a finite number, got "${raw}"`)
  }
  if (value < MIN_POLL_INTERVAL_MS) {
    throw new Error(
      `AUTOMATION_POLL_INTERVAL_MS must be >= ${MIN_POLL_INTERVAL_MS}ms, got "${raw}"`,
    )
  }
  return Math.floor(value)
}

/** Read + validate the per-run lease duration from the environment. */
export function leaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTOMATION_LEASE_MS
  if (raw === undefined) return DEFAULT_LEASE_MS
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`AUTOMATION_LEASE_MS must be a finite number, got "${raw}"`)
  }
  if (value < MIN_LEASE_MS) {
    throw new Error(`AUTOMATION_LEASE_MS must be >= ${MIN_LEASE_MS}ms, got "${raw}"`)
  }
  return Math.floor(value)
}

/**
 * Atomically lease the oldest due settings rows. A row is due when it is
 * enabled, its `nextSyncAt` is not in the future, and its lease is missing or
 * expired (reclaimable after a crashed worker). `FOR UPDATE SKIP LOCKED`
 * guarantees that two racing workers never lease the same row.
 */
export async function claimDueSettings(
  workerId: string,
  now: Date,
): Promise<ClaimedSettings[]> {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs())

  const rows = await automationPrisma.$queryRawUnsafe<RawClaimRow[]>(
    `UPDATE "AutomationSettings"
     SET "workerId" = $1,
         "leaseExpiresAt" = $2,
         "updatedAt" = $3
     WHERE "id" IN (
       SELECT "id" FROM "AutomationSettings"
       WHERE "enabled" = true
         AND "nextSyncAt" <= $3
         AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < $3)
       ORDER BY "nextSyncAt" ASC
       LIMIT $4
       FOR UPDATE SKIP LOCKED
     )
     RETURNING
       "id"::text AS "id",
       "userId"::text AS "userId",
       "autoAnalyze" AS "autoAnalyze",
       "intervalMinutes"::int AS "intervalMinutes",
       "nextSyncAt" AS "nextSyncAt"`,
    workerId,
    leaseExpiresAt,
    now,
    CLAIM_BATCH_SIZE,
  )

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    autoAnalyze: row.autoAnalyze,
    intervalMinutes: row.intervalMinutes,
    nextSyncAt: new Date(row.nextSyncAt),
  }))
}

/**
 * Release the lease on a settings row and advance `nextSyncAt`. Fenced on
 * `workerId`: if the lease was reclaimed or cancelled (e.g. the user paused),
 * this is a no-op and the row is not rescheduled.
 */
export async function releaseSettingsLease(
  settingsId: string,
  workerId: string,
  nextSyncAt: Date,
  now: Date,
): Promise<boolean> {
  const affected = await automationPrisma.$executeRawUnsafe(
    `UPDATE "AutomationSettings"
     SET "leaseExpiresAt" = NULL,
         "workerId" = NULL,
         "nextSyncAt" = $2,
         "updatedAt" = $3
     WHERE "id" = $1 AND "workerId" = $4`,
    settingsId,
    nextSyncAt,
    now,
    workerId,
  )
  return affected > 0
}

/** Run the scheduled sync for one claimed settings row. */
async function runClaimedSetting(
  claim: ClaimedSettings,
  workerId: string,
): Promise<ProcessedClaim> {
  const startedAt = new Date()
  try {
    const summary = await runUserSync({
      userId: claim.userId,
      trigger: "scheduled",
      autoAnalyze: claim.autoAnalyze,
      now: startedAt,
    })
    console.log(
      `[automation] scheduled sync for ${claim.userId}: run=${summary.runId} status=${summary.status}`,
    )
    return { userId: claim.userId, ok: summary.status !== "failed", status: summary.status }
  } catch (error) {
    // The sync service records global failures (status=failed + error) on the
    // SyncRun row before rethrowing; SyncRunInProgressError means another run
    // already owns the per-user slot. Either way the worker must not crash.
    if (error instanceof SyncRunInProgressError) {
      console.warn(
        `[automation] scheduled sync for ${claim.userId} skipped: a sync is already in progress`,
      )
      return { userId: claim.userId, ok: true, status: "skipped" }
    }
    const message = error instanceof Error ? error.message : "Unknown sync error"
    console.warn(`[automation] scheduled sync for ${claim.userId} failed: ${message}`)
    return { userId: claim.userId, ok: false, error: message }
  } finally {
    // Always reschedule — even on failure — unless the lease was cancelled.
    try {
      const now = new Date()
      const nextSyncAt = computeNextSyncAt(now, claim.intervalMinutes)
      const released = await releaseSettingsLease(claim.id, workerId, nextSyncAt, now)
      if (!released) {
        console.warn(
          `[automation] lease for ${claim.userId} already cancelled/reclaimed; not rescheduling`,
        )
      }
    } catch (error) {
      console.error(`[automation] failed to release lease for ${claim.userId}:`, error)
    }
  }
}

/**
 * Run one scheduling round: claim all due settings and process them. Exported
 * for the worker loop and for unit/integration tests. Never throws for a
 * sync-scoped failure; only connection/tooling failures inside `processDueSchedules`
 * itself are reported through the returned `error` field.
 */
export async function processDueSchedules(options: {
  workerId: string
  now?: Date
}): Promise<ProcessDueSchedulesResult> {
  const now = options.now ?? new Date()

  let claims: ClaimedSettings[]
  try {
    claims = await claimDueSettings(options.workerId, now)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown claim error"
    console.error(`[automation] claim round failed:`, error)
    return { claimed: 0, processed: [], error: message }
  }

  const processed: ProcessedClaim[] = []
  for (const claim of claims) {
    processed.push(await runClaimedSetting(claim, options.workerId))
  }

  return { claimed: claims.length, processed }
}