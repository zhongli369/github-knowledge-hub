"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import {
  runUserSync,
  SyncRunInProgressError,
} from "@/services/sync/incremental-sync.service"
import { automationPrisma } from "@/services/automation/automation.db"
import type { AutomationSettingsRow, SyncRunRow } from "@/services/automation/automation.db"
import {
  getOrCreateAutomationSettings,
  updateAutomationSettings,
  SettingsValidationError,
} from "@/services/automation/settings.service"
import {
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
} from "@/services/automation/policy"

const UpdateSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoAnalyze: z.boolean().optional(),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_SYNC_INTERVAL_MINUTES)
      .max(MAX_SYNC_INTERVAL_MINUTES)
      .optional(),
  })
  .refine(
    (v) =>
      v.enabled !== undefined ||
      v.autoAnalyze !== undefined ||
      v.intervalMinutes !== undefined,
    { message: "At least one setting field is required" },
  )

// NOTE: this view intentionally does NOT expose workerId / leaseExpiresAt —
// worker identity leaks hostname/pid/uuid and lease internals are not needed by
// the UI. The client expresses state via `enabled` + the latest SyncRun only.
export interface AutomationSettingsView {
  enabled: boolean
  autoAnalyze: boolean
  intervalMinutes: number
  nextSyncAt: string | null
}

export interface SyncRunView {
  id: string
  trigger: string
  status: string
  totalCount: number
  processedCount: number
  addedCount: number
  updatedCount: number
  unchangedCount: number
  unstarredCount: number
  failedCount: number
  analysisQueuedCount: number
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface AnalysisStatusCounts {
  pending: number
  running: number
  completed: number
  failed: number
}

export interface AutomationDashboardData {
  settings: AutomationSettingsView
  latestRun: SyncRunView | null
  recentRuns: SyncRunView[]
  analysisCounts: AnalysisStatusCounts
  now: string
}

export type AutomationDashboardResult =
  | { ok: true; data: AutomationDashboardData; error: null }
  | { ok: false; data: null; error: string }

export type UpdateAutomationSettingsResult =
  | { ok: true; data: AutomationSettingsView; error: null }
  | { ok: false; data: null; error: string }

export type RunAutomationNowResult =
  | { ok: true; error: null; alreadyRunning: true; run: null }
  | { ok: true; error: null; alreadyRunning: false; run: SyncRunView | null }
  | { ok: false; error: string; alreadyRunning: false; run: null }

function toSettingsView(settings: AutomationSettingsRow): AutomationSettingsView {
  return {
    enabled: settings.enabled,
    autoAnalyze: settings.autoAnalyze,
    intervalMinutes: settings.intervalMinutes,
    nextSyncAt: settings.nextSyncAt.toISOString(),
  }
}

function toSyncRunView(run: SyncRunRow): SyncRunView {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    totalCount: run.totalCount,
    processedCount: run.processedCount,
    addedCount: run.addedCount,
    updatedCount: run.updatedCount,
    unchangedCount: run.unchangedCount,
    unstarredCount: run.unstarredCount,
    failedCount: run.failedCount,
    analysisQueuedCount: run.analysisQueuedCount,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }
}

/**
 * Snapshot for the /automation page, scoped to the authenticated user.
 * Creates the settings row on first access so the page always has something
 * to render.
 */
export async function getAutomationDashboardAction(): Promise<AutomationDashboardResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { ok: false, error: "Not authenticated", data: null }
  }
  const userId = session.user.id

  try {
    const [settings, latestRun, recentRuns, analysisGroups] = await Promise.all([
      getOrCreateAutomationSettings(userId),
      automationPrisma.syncRun.findFirst({
        where: { userId },
        orderBy: { startedAt: "desc" },
      }),
      automationPrisma.syncRun.findMany({
        where: { userId },
        orderBy: { startedAt: "desc" },
        take: 10,
      }),
      automationPrisma.analysis.groupBy({
        by: ["status"],
        where: { userId },
        _count: { _all: true },
      }),
    ])

    const counts: AnalysisStatusCounts = { pending: 0, running: 0, completed: 0, failed: 0 }
    for (const group of analysisGroups) {
      const status = group.status as keyof AnalysisStatusCounts
      if (status in counts) counts[status] = group._count._all
    }

    return {
      ok: true,
      error: null,
      data: {
        settings: toSettingsView(settings),
        latestRun: latestRun ? toSyncRunView(latestRun) : null,
        recentRuns: recentRuns.map(toSyncRunView),
        analysisCounts: counts,
        now: new Date().toISOString(),
      },
    }
  } catch (error) {
    // Never surface raw DB/internal errors to the client.
    console.error(`[automation] dashboard load failed for ${userId}:`, error)
    return { ok: false, error: "Failed to load automation dashboard", data: null }
  }
}

/**
 * Update the authenticated user's automation settings. `userId` is always taken
 * from the session — never from client input. Boundary validation is done both
 * here (zod) and in the settings service (policy.normalizeSyncIntervalMinutes).
 */
export async function updateAutomationSettingsAction(
  input: unknown,
): Promise<UpdateAutomationSettingsResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { ok: false, error: "Not authenticated", data: null }
  }

  const parsed = UpdateSettingsSchema.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      error: first ? first.message : "Invalid settings",
      data: null,
    }
  }

  try {
    const settings = await updateAutomationSettings(session.user.id, parsed.data)
    revalidatePath("/automation")
    return { ok: true, error: null, data: toSettingsView(settings) }
  } catch (error) {
    // Validation messages are intentional and user-facing; anything else
    // (DB / internal) is logged and replaced with a generic message.
    if (error instanceof SettingsValidationError) {
      return { ok: false, error: error.message, data: null }
    }
    console.error(`[automation] settings update failed for ${session.user.id}:`, error)
    return { ok: false, error: "Failed to update automation settings", data: null }
  }
}

/**
 * Run a sync immediately for the authenticated user. A manual run is always
 * triggered as `trigger: "manual"` — never faked as "scheduled". When a
 * sync is already running (manual or scheduled — enforced by the per-user
 * running partial unique index), returns `alreadyRunning: true` with no new
 * run.
 */
export async function runAutomationNowAction(): Promise<RunAutomationNowResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { ok: false, error: "Not authenticated", alreadyRunning: false, run: null }
  }
  const userId = session.user.id

  try {
    const settings = await getOrCreateAutomationSettings(userId)
    await runUserSync({
      userId,
      trigger: "manual",
      autoAnalyze: settings.autoAnalyze,
      now: new Date(),
    })

    revalidatePath("/automation")
    const latest = await automationPrisma.syncRun.findFirst({
      where: { userId },
      orderBy: { startedAt: "desc" },
    })
    return {
      ok: true,
      error: null,
      alreadyRunning: false,
      run: latest ? toSyncRunView(latest) : null,
    }
  } catch (error) {
    if (error instanceof SyncRunInProgressError) {
      // Friendly concurrency case: another run already owns the slot.
      return { ok: true, error: null, alreadyRunning: true, run: null }
    }
    // The real failure (with details) is recorded on the SyncRun row by the
    // sync service; the client only needs a generic, non-leaking message.
    console.error(`[automation] manual sync failed for ${userId}:`, error)
    return { ok: false, error: "Failed to start sync", alreadyRunning: false, run: null }
  }
}