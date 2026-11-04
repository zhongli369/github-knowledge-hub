/**
 * Analysis worker leasing primitives (P1 Agent B).
 *
 * A task (an `Analysis` row) is owned by exactly one worker at a time. This
 * module owns the atomic claim, lease renewal, and conditional terminal
 * updates. All writes are raw SQL so that PostgreSQL provides the atomicity:
 *
 *   * `claimNextAnalysis` claims the oldest claimable task in a single
 *     `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. Two
 *     workers racing on the same queue can never lease the same row.
 *   * `renewLease` only succeeds while the caller still holds a valid lease.
 *   * `completeAnalysis` / `failAnalysis` are conditional on `workerId` AND a
 *     not-yet-expired lease, so a stale worker can never overwrite the result
 *     of a newer worker that reclaimed the task.
 *
 * Attempts are bounded: every claim increments `attempts`, and neither the
 * claim predicate nor `failAnalysis` will ever let `attempts` exceed a hard
 * ceiling without reaching the terminal `failed` state, so a poisoned task
 * cannot loop forever.
 */

import os from "node:os"
import crypto from "node:crypto"
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"

/** How long a worker owns a task before the lease lapses and a new worker may reclaim it. */
export const LEASE_DURATION_MS = 60_000

/** Heartbeat cadence; kept well under LEASE_DURATION_MS so a live worker always succeeds. */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** A task is claimed at most this many times before it terminally fails. */
export const MAX_ATTEMPTS = 3

export const ABANDONED_AFTER_MAX_ATTEMPTS = "Abandoned after maximum attempts"

export interface ClaimableAnalysis {
  id: string
  analysisType: string
  repositoryId: string | null
  userId: string
  input: Prisma.InputJsonValue | null
  attempts: number
  workerId: string
  leaseExpiresAt: Date
}

export interface ClaimOptions {
  workerId: string
  now?: Date
  maxAttempts?: number
  leaseDurationMs?: number
}

interface ClaimRow {
  id: string
  analysisType: string
  repositoryId: string | null
  userId: string
  input: Prisma.InputJsonValue | null
  status: string
  attempts: number
  workerId: string | null
  leaseExpiresAt: Date | null
}

/** Create a stable, per-process worker identity. */
export function createWorkerId(): string {
  return `worker:${os.hostname()}:${process.pid}:${crypto.randomUUID()}`
}

/**
 * Atomically claim the oldest claimable task.
 *
 * A task is claimable when it is `pending` (with headroom below maxAttempts) or
 * when it is `running` with an expired lease. If a claimable `running` row has
 * already reached `maxAttempts` (e.g. a worker crashed after its final claim),
 * the row is converted to terminal `failed` here rather than re-leased, which
 * is what guarantees the "no infinite loop" property.
 *
 * Returns the claimed task, or `null` when nothing was claimable.
 */
export async function claimNextAnalysis(options: ClaimOptions): Promise<ClaimableAnalysis | null> {
  const { workerId } = options
  const now = options.now ?? new Date()
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const leaseExpiresAt = new Date(now.getTime() + (options.leaseDurationMs ?? LEASE_DURATION_MS))

  const rows = await prisma.$queryRawUnsafe<ClaimRow[]>(
    `UPDATE "Analysis"
     SET
       "status" = CASE WHEN "attempts" >= $4 THEN 'failed' ELSE 'running' END,
       "error" = CASE WHEN "attempts" >= $4 THEN $5 ELSE NULL END,
       "workerId" = CASE WHEN "attempts" >= $4 THEN "workerId" ELSE $1 END,
       "claimedAt" = CASE WHEN "attempts" >= $4 THEN "claimedAt" ELSE $2 END,
       "leaseExpiresAt" = CASE WHEN "attempts" >= $4 THEN NULL ELSE $3 END,
       -- An exhausted row (reaching max attempts on an expired lease) is
       -- converted to terminal failed here, so it must NOT consume another
       -- attempt: its attempts stay capped at maxAttempts.
       "attempts" = CASE WHEN "attempts" >= $4 THEN "attempts" ELSE "attempts" + 1 END,
       "updatedAt" = $2
     WHERE "id" IN (
       SELECT "id" FROM "Analysis"
       WHERE ("status" = 'pending' AND "attempts" < $4)
          OR ("status" = 'running' AND "leaseExpiresAt" < $2)
       ORDER BY "createdAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING
       "id"::text AS "id",
       "analysisType"::text AS "analysisType",
       "repositoryId"::text AS "repositoryId",
       "userId"::text AS "userId",
       "input",
       "status"::text AS "status",
       "attempts"::int AS "attempts",
       "workerId"::text AS "workerId",
       "leaseExpiresAt" AS "leaseExpiresAt"`,
    workerId,
    now,
    leaseExpiresAt,
    maxAttempts,
    ABANDONED_AFTER_MAX_ATTEMPTS,
  )

  const row = rows[0]
  // A returned "failed" row means the task was exhausted and terminally failed;
  // it is not a claim, so surface nothing to the caller.
  if (!row || row.status !== "running" || !row.workerId || !row.leaseExpiresAt) {
    return null
  }

  return {
    id: row.id,
    analysisType: row.analysisType,
    repositoryId: row.repositoryId,
    userId: row.userId,
    input: row.input,
    attempts: row.attempts,
    workerId: row.workerId,
    leaseExpiresAt: row.leaseExpiresAt,
  }
}

export interface HeartbeatOptions {
  analysisId: string
  workerId: string
  now?: Date
  leaseDurationMs?: number
}

/**
 * Renew the caller's lease. Succeeds only while the caller still owns the
 * task and the previous lease has not yet expired in the database.
 */
export async function renewLease(options: HeartbeatOptions): Promise<boolean> {
  const now = options.now ?? new Date()
  const renewedLease = new Date(now.getTime() + (options.leaseDurationMs ?? LEASE_DURATION_MS))

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "Analysis"
     SET "leaseExpiresAt" = $3, "updatedAt" = $4
     WHERE "id" = $1
       AND "workerId" = $2
       AND "status" = 'running'
       AND "leaseExpiresAt" > $4`,
    options.analysisId,
    options.workerId,
    renewedLease,
    now,
  )
  return affected > 0
}

export interface CompleteOptions {
  analysisId: string
  workerId: string
  now?: Date
  status?: "completed" | "failed"
  result?: Prisma.InputJsonValue
  model?: string
  tokensUsed?: number
  durationMs?: number
}

/**
 * Mark a task completed. The UPDATE is conditional on the caller still owning
 * the task (`workerId`) and holding a valid lease (`leaseExpiresAt > now`), so
 * a stale worker can never clobber the result written by a newer worker.
 */
export async function completeAnalysis(options: CompleteOptions): Promise<boolean> {
  const now = options.now ?? new Date()
  const resultJson = options.result == null ? null : JSON.stringify(options.result)

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "Analysis"
     SET
       "status" = $4,
       "result" = COALESCE($5::jsonb, "result"),
       "model" = COALESCE($6, "model"),
       "tokensUsed" = COALESCE($7, "tokensUsed"),
       "durationMs" = COALESCE($8, "durationMs"),
       "leaseExpiresAt" = NULL,
       "updatedAt" = $3
     WHERE "id" = $1
       AND "workerId" = $2
       AND "status" = 'running'
       AND "leaseExpiresAt" > $3`,
    options.analysisId,
    options.workerId,
    now,
    options.status ?? "completed",
    resultJson,
    options.model ?? null,
    options.tokensUsed ?? null,
    options.durationMs ?? null,
  )
  return affected > 0
}

export interface FailOptions {
  analysisId: string
  workerId: string
  now?: Date
  error: string
  maxAttempts?: number
}

/**
 * Conditional failure. When `attempts` has reached `maxAttempts` the task is
 * terminally `failed`; otherwise it is released back to `pending` so another
 * worker (with remaining budget) can retry. Fails (returns false) silently
 * when the caller no longer owns a valid lease.
 */
export async function failAnalysis(options: FailOptions): Promise<boolean> {
  const now = options.now ?? new Date()
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "Analysis"
     SET
       "error" = $4,
       "status" = CASE WHEN "attempts" >= $5 THEN 'failed' ELSE 'pending' END,
       "workerId" = CASE WHEN "attempts" >= $5 THEN "workerId" ELSE NULL END,
       "leaseExpiresAt" = NULL,
       "claimedAt" = NULL,
       "updatedAt" = $3
     WHERE "id" = $1
       AND "workerId" = $2
       AND "status" = 'running'
       AND "leaseExpiresAt" > $3`,
    options.analysisId,
    options.workerId,
    now,
    options.error.slice(0, 1000),
    maxAttempts,
  )
  return affected > 0
}