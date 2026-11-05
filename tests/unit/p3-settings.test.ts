import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ── P3 automation settings service (cross-module unit) ──
// Verifies the get-or-create defaults, the update carve-out (only
// enabled/autoAnalyze/intervalMinutes are writable), and the schedule
// bookkeeping (enable -> schedule from now, pause -> cancel lease, interval
// change -> recompute only while enabled). All Prisma I/O mocked through
// @/lib/prisma; no real DB.

const settingsMocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationSettings: {
      findUnique: settingsMocks.findUnique,
      create: settingsMocks.create,
      update: settingsMocks.update,
    },
  },
}))

import {
  getAutomationSettings,
  getOrCreateAutomationSettings,
  updateAutomationSettings,
  SettingsValidationError,
  DEFAULT_INTERVAL_MINUTES,
} from "@/services/automation/settings.service"
import type { AutomationSettingsRow } from "@/services/automation/automation.db"

const NOW = new Date("2026-01-01T00:00:00.000Z")
const HOUR = 60 * 60_000

function row(overrides: Partial<AutomationSettingsRow> = {}): AutomationSettingsRow {
  return {
    id: "settings-1",
    userId: "u1",
    enabled: false,
    autoAnalyze: true,
    intervalMinutes: 60,
    nextSyncAt: new Date(NOW.getTime() + HOUR),
    leaseExpiresAt: null,
    workerId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  settingsMocks.findUnique.mockResolvedValue(null)
  settingsMocks.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    ...row(),
    ...args.data,
  }))
  settingsMocks.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    ...row(),
    ...args.data,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("getAutomationSettings / getOrCreateAutomationSettings", () => {
  it("returns the existing row when present", async () => {
    const existing = row({ enabled: true })
    settingsMocks.findUnique.mockResolvedValue(existing)

    await expect(getAutomationSettings("u1")).resolves.toEqual(existing)
    expect(settingsMocks.create).not.toHaveBeenCalled()
  })

  it("creates a row with documented defaults (disabled, autoAnalyze on, 60m) on first access", async () => {
    const created = await getOrCreateAutomationSettings("u1")

    expect(created).toMatchObject({
      userId: "u1",
      enabled: false,
      autoAnalyze: true,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    })
    const data = settingsMocks.create.mock.calls[0][0]?.data as Record<string, unknown>
    expect(data.userId).toBe("u1")
    expect(data.nextSyncAt).toBeInstanceOf(Date)
    // From now (2026-01-01T00:00Z) + 60 minutes.
    expect((data.nextSyncAt as Date).toISOString()).toBe("2026-01-01T01:00:00.000Z")
  })

  it("re-reads the winner when a concurrent first-access create hits the userId unique index", async () => {
    settingsMocks.create.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }))
    settingsMocks.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ enabled: true }))

    const settings = await getOrCreateAutomationSettings("u1")

    expect(settings.enabled).toBe(true)
    expect(settingsMocks.findUnique).toHaveBeenCalledTimes(2)
  })
})

describe("updateAutomationSettings — update carve-out & schedule bookkeeping", () => {
  it("rejects an unknown field with a user-facing validation error", async () => {
    settingsMocks.findUnique.mockResolvedValue(row())

    await expect(
      updateAutomationSettings("u1", { leet: 1 } as unknown as { intervalMinutes?: number }),
    ).rejects.toBeInstanceOf(SettingsValidationError)
    expect(settingsMocks.update).not.toHaveBeenCalled()
  })

  it("accepts a no-op update without writing", async () => {
    settingsMocks.findUnique.mockResolvedValue(row())

    const settings = await updateAutomationSettings("u1", {})

    expect(settings).toMatchObject({ id: "settings-1" })
    expect(settingsMocks.update).not.toHaveBeenCalled()
  })

  it("enabling schedules the next sync from now at the current interval", async () => {
    settingsMocks.findUnique.mockResolvedValue(row({ enabled: false, intervalMinutes: 60 }))

    await updateAutomationSettings("u1", { enabled: true })

    const data = settingsMocks.update.mock.calls[0][0]?.data as Record<string, unknown>
    expect(data).toMatchObject({ enabled: true })
    expect((data.nextSyncAt as Date).toISOString()).toBe("2026-01-01T01:00:00.000Z")
  })

  it("pausing cancels the scheduler lease without touching nextSyncAt", async () => {
    settingsMocks.findUnique.mockResolvedValue(
      row({
        enabled: true,
        leaseExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
        workerId: "automation:host:123:uuid",
      }),
    )

    await updateAutomationSettings("u1", { enabled: false })

    const data = settingsMocks.update.mock.calls[0][0]?.data as Record<string, unknown>
    // The worker's losing release is fenced on workerId and becomes a no-op, so
    // cancelling the lease here prevents any later reschedule.
    expect(data).toMatchObject({ enabled: false, leaseExpiresAt: null, workerId: null })
    expect(data.nextSyncAt).toBeUndefined()
  })

  it("recomputes nextSyncAt when the interval changes on an enabled schedule", async () => {
    settingsMocks.findUnique.mockResolvedValue(row({ enabled: true, intervalMinutes: 60 }))

    await updateAutomationSettings("u1", { intervalMinutes: 120 })

    const data = settingsMocks.update.mock.calls[0][0]?.data as Record<string, unknown>
    expect(data).toMatchObject({ intervalMinutes: 120 })
    // now + 120 minutes.
    expect((data.nextSyncAt as Date).toISOString()).toBe("2026-01-01T02:00:00.000Z")
  })

  it("does not recompute nextSyncAt for an interval change on a disabled schedule", async () => {
    settingsMocks.findUnique.mockResolvedValue(row({ enabled: false, intervalMinutes: 60 }))

    await updateAutomationSettings("u1", { intervalMinutes: 120 })

    const data = settingsMocks.update.mock.calls[0][0]?.data as Record<string, unknown>
    expect(data.intervalMinutes).toBe(120)
    expect(data.nextSyncAt).toBeUndefined()
  })

  it("surfaces a friendly validation error for an out-of-range interval", async () => {
    settingsMocks.findUnique.mockResolvedValue(row())

    await expect(updateAutomationSettings("u1", { intervalMinutes: 5 })).rejects.toBeInstanceOf(
      SettingsValidationError,
    )
    expect(settingsMocks.update).not.toHaveBeenCalled()
  })
})