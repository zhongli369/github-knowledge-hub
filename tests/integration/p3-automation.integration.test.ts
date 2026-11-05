import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { prisma } from "@/lib/prisma"
import { automationPrisma } from "@/services/automation/automation.db"
import { computeNextSyncAt } from "@/services/automation/policy"
import {
  claimDueSettings,
  leaseMs,
  releaseSettingsLease,
} from "@/services/automation/scheduler.service"

const USER_ID = "p3-automation-lease-user"
const NOW = new Date("2026-11-05T12:00:00.000Z")

beforeAll(async () => {
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(databaseName)) {
    throw new Error("P3 automation tests refuse to run outside an isolated fresh test database")
  }

  await prisma.user.create({
    data: { id: USER_ID, name: "P3 Automation Lease User", updatedAt: NOW },
  })
})

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER_ID } })
  await prisma.$disconnect()
})

describe("PostgreSQL automation settings leasing", () => {
  it("allows one racing worker, rejects stale release, and reschedules exactly once", async () => {
    const due = await automationPrisma.automationSettings.create({
      data: {
        userId: USER_ID,
        enabled: true,
        autoAnalyze: true,
        intervalMinutes: 60,
        nextSyncAt: NOW,
      },
    })

    const [a, b] = await Promise.all([
      claimDueSettings("automation-worker-a", NOW),
      claimDueSettings("automation-worker-b", NOW),
    ])
    const claims = [...a, ...b]
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ id: due.id, userId: USER_ID, intervalMinutes: 60 })

    const winner = a.length === 1 ? "automation-worker-a" : "automation-worker-b"
    const loser = winner === "automation-worker-a" ? "automation-worker-b" : "automation-worker-a"
    expect(await releaseSettingsLease(due.id, loser, computeNextSyncAt(NOW, 60), NOW)).toBe(false)

    const nextSyncAt = computeNextSyncAt(NOW, 60)
    expect(await releaseSettingsLease(due.id, winner, nextSyncAt, NOW)).toBe(true)
    const released = await automationPrisma.automationSettings.findUnique({
      where: { userId: USER_ID },
    })
    expect(released).toMatchObject({ workerId: null, leaseExpiresAt: null })
    expect(released?.nextSyncAt.toISOString()).toBe(nextSyncAt.toISOString())

    expect(await claimDueSettings("automation-worker-b", NOW)).toEqual([])
    const nextClaims = await claimDueSettings("automation-worker-b", nextSyncAt)
    expect(nextClaims).toHaveLength(1)
    expect(nextClaims[0]?.id).toBe(due.id)

    // An active lease is not stealable, but a crashed worker's expired lease is.
    expect(await claimDueSettings("automation-worker-a", nextSyncAt)).toEqual([])
    const afterExpiry = new Date(nextSyncAt.getTime() + leaseMs() + 1)
    const reclaimed = await claimDueSettings("automation-worker-a", afterExpiry)
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.id).toBe(due.id)
  })
})
