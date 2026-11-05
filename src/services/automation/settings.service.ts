/**
 * Automation settings service (P3).
 *
 * Per-user configuration for the scheduled sync worker. Owns:
 *   * get-or-create of the AutomationSettings row,
 *   * the update carve-out: only `enabled` / `autoAnalyze` / `intervalMinutes`
 *     may change; anything else is rejected,
 *   * scheduling bookkeeping: enabling/re-enabling schedules the next
 *     `nextSyncAt`, an interval change recomputes it, and pausing cancels the
 *     scheduler lease without ever touching an in-flight SyncRun.
 *
 * Concurrency: every query is scoped to `userId`; callers must derive it from
 * the authenticated session, never from pageload/client input.
 */

import {
  automationPrisma,
  type AutomationSettingsRow,
  type SettingsUpdateInput,
} from "./automation.db"
import { computeNextSyncAt, normalizeSyncIntervalMinutes } from "./policy"

const DEFAULT_ENABLED = false
const DEFAULT_AUTO_ANALYZE = true
export const DEFAULT_INTERVAL_MINUTES = 60

const ALLOWED_UPDATE_KEYS = new Set(["enabled", "autoAnalyze", "intervalMinutes"])

/**
 * Validation error whose message is intentional and user-facing. Server Actions
 * surface it verbatim; anything else is logged server-side and replaced with a
 * generic message so raw DB/internal details never reach the client.
 */
export class SettingsValidationError extends Error {
  override readonly name = "SettingsValidationError"

  constructor(message: string) {
    super(message)
  }
}

export interface SettingsUpdateAllowed {
  enabled?: boolean
  autoAnalyze?: boolean
  intervalMinutes?: number
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002"
}

/** Fetch the settings row for a user, or `null` when none exists yet. */
export async function getAutomationSettings(
  userId: string,
): Promise<AutomationSettingsRow | null> {
  return automationPrisma.automationSettings.findUnique({ where: { userId } })
}

/**
 * Return the user's settings, creating the row on first access with the
 * documented defaults. Atomic against the very-first-access race: if two
 * requests create concurrently, the losing `create` hits the `userId` unique
 * index (P2002) and we re-read the winner instead of failing.
 */
export async function getOrCreateAutomationSettings(
  userId: string,
): Promise<AutomationSettingsRow> {
  const existing = await getAutomationSettings(userId)
  if (existing) return existing

  const now = new Date()
  try {
    return await automationPrisma.automationSettings.create({
      data: {
        userId,
        enabled: DEFAULT_ENABLED,
        autoAnalyze: DEFAULT_AUTO_ANALYZE,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        nextSyncAt: computeNextSyncAt(now, DEFAULT_INTERVAL_MINUTES),
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      const created = await getAutomationSettings(userId)
      if (created) return created
    }
    throw error
  }
}

/**
 * Update the user's settings. Only `enabled` / `autoAnalyze` /
 * `intervalMinutes` are accepted; unknown keys throw. Boundary validation is
 * delegated to `normalizeSyncIntervalMinutes` (throws with an explicit message
 * for non-finite / non-integer / out-of-range values).
 */
export async function updateAutomationSettings(
  userId: string,
  update: SettingsUpdateAllowed,
): Promise<AutomationSettingsRow> {
  const current = await getOrCreateAutomationSettings(userId)

  for (const key of Object.keys(update)) {
    if (!ALLOWED_UPDATE_KEYS.has(key)) {
      throw new SettingsValidationError(`Unknown setting field "${key}"`)
    }
  }

  const now = new Date()
  const data: SettingsUpdateInput = {}

  let interval = current.intervalMinutes
  if (update.intervalMinutes !== undefined) {
    try {
      interval = normalizeSyncIntervalMinutes(update.intervalMinutes)
    } catch (error) {
      // Re-surface the policy message as a friendly validation error.
      throw new SettingsValidationError(
        error instanceof Error ? error.message : `Invalid sync interval: ${update.intervalMinutes}`,
      )
    }
    data.intervalMinutes = interval
  }
  if (update.autoAnalyze !== undefined) data.autoAnalyze = update.autoAnalyze

  const intervalChanged = update.intervalMinutes !== undefined && interval !== current.intervalMinutes

  if (update.enabled !== undefined) {
    data.enabled = update.enabled
    if (update.enabled === true) {
      // Enabling or re-enabling: schedule from now at the current interval.
      data.nextSyncAt = computeNextSyncAt(now, interval)
    } else {
      // Pausing: cancel the scheduler lease so an in-flight worker's final
      // release becomes a no-op (gated on workerId). The running SyncRun row
      // itself is never touched here.
      data.leaseExpiresAt = null
      data.workerId = null
    }
  } else if (intervalChanged && current.enabled) {
    // Interval change on an enabled schedule: recompute the next sync.
    data.nextSyncAt = computeNextSyncAt(now, interval)
  }

  if (Object.keys(data).length === 0) return current

  return automationPrisma.automationSettings.update({ where: { userId }, data })
}