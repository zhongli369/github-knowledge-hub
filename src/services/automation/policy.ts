/**
 * Automation sync scheduling policy (P3).
 *
 * Pure constants and functions only — no Prisma / Next.js imports, so this
 * module stays trivially unit-testable and dependency-free. All boundary
 * inputs are validated here (fail loudly with explicit messages).
 */

/** Absolute lower bound for a sync interval, in minutes (15 minutes). */
export const MIN_SYNC_INTERVAL_MINUTES = 15

/** Absolute upper bound for a sync interval, in minutes (7 days). */
export const MAX_SYNC_INTERVAL_MINUTES = 10_080

export interface ScheduleDueView {
  enabled: boolean
  nextSyncAt: Date | null
  leaseExpiresAt?: Date | null
}

/**
 * Validate a sync interval and return the accepted integer value.
 *
 * Rejects non-finite, non-integer and out-of-range values with an explicit
 * message so callers can surface a user-friendly error.
 */
export function normalizeSyncIntervalMinutes(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Sync interval must be a finite number of minutes, got ${JSON.stringify(value)}`,
    )
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `Sync interval must be a whole number of minutes, got ${value}`,
    )
  }
  if (value < MIN_SYNC_INTERVAL_MINUTES || value > MAX_SYNC_INTERVAL_MINUTES) {
    throw new Error(
      `Sync interval must be between ${MIN_SYNC_INTERVAL_MINUTES} and ${MAX_SYNC_INTERVAL_MINUTES} minutes, got ${value}`,
    )
  }
  return value
}

/**
 * Compute when the next sync should run. Validates both arguments.
 */
export function computeNextSyncAt(from: Date, intervalMinutes: number): Date {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new Error("computeNextSyncAt: `from` must be a valid Date")
  }
  const interval = normalizeSyncIntervalMinutes(intervalMinutes)
  return new Date(from.getTime() + interval * 60_000)
}

/**
 * A setting is "due" when it is enabled, its nextSyncAt is not in the future,
 * and no worker holds a still-valid lease on it.
 */
export function isScheduleDue(settings: ScheduleDueView, now: Date): boolean {
  if (!settings.enabled) return false
  if (!settings.nextSyncAt) return false
  if (settings.nextSyncAt.getTime() > now.getTime()) return false
  if (settings.leaseExpiresAt && settings.leaseExpiresAt.getTime() > now.getTime()) return false
  return true
}