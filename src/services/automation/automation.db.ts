/**
 * Typed access to the automation models (AutomationSettings / SyncRun).
 *
 * P3 owns the *usage* of these models. The schema change is delivered by the
 * sync Agent (migration 20261105120000_p3_auto_sync); until `prisma generate`
 * runs against a schema that contains the models, `@prisma/client` has no
 * delegate for them, so this module declares the row shapes and exposes a
 * small typed facade over the shared Prisma instance. The facade is cast
 * through `unknown`, so it typechecks both before and after generation (after
 * generation the real delegates are called at runtime through the same cast).
 *
 * All queries here are scoped to a single `userId`; callers must pass it from
 * the authenticated session, never from client input.
 */

import { prisma } from "@/lib/prisma"

export interface AutomationSettingsRow {
  id: string
  userId: string
  enabled: boolean
  autoAnalyze: boolean
  intervalMinutes: number
  nextSyncAt: Date
  leaseExpiresAt: Date | null
  workerId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface SyncRunRow {
  id: string
  userId: string
  trigger: string // "manual" | "scheduled"
  status: string // "running" | "completed" | "failed"
  totalCount: number
  processedCount: number
  addedCount: number
  updatedCount: number
  unchangedCount: number
  unstarredCount: number
  failedCount: number
  analysisQueuedCount: number
  error: string | null
  startedAt: Date
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface SettingsCreateInput {
  userId: string
  enabled?: boolean
  autoAnalyze?: boolean
  intervalMinutes?: number
  nextSyncAt?: Date
}

export interface SettingsUpdateInput {
  enabled?: boolean
  autoAnalyze?: boolean
  intervalMinutes?: number
  nextSyncAt?: Date
  leaseExpiresAt?: Date | null
  workerId?: string | null
}

type SyncRunOrderBy =
  | { startedAt?: "asc" | "desc"; createdAt?: "asc" | "desc" }
  | { startedAt?: "asc" | "desc" }[]

interface SyncRunQueryBy {
  where?: Partial<SyncRunRow>
  orderBy?: SyncRunOrderBy
  take?: number
}

export interface AutomationPrisma {
  automationSettings: {
    findUnique(args: { where: { userId: string } }): Promise<AutomationSettingsRow | null>
    create(args: { data: SettingsCreateInput }): Promise<AutomationSettingsRow>
    update(args: { where: { userId: string }; data: SettingsUpdateInput }): Promise<AutomationSettingsRow>
  }
  syncRun: {
    findFirst(args: SyncRunQueryBy): Promise<SyncRunRow | null>
    findMany(args: SyncRunQueryBy): Promise<SyncRunRow[]>
  }
}

export const automationPrisma = prisma as typeof prisma & AutomationPrisma