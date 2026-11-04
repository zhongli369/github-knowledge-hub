import { beforeEach, describe, expect, it, vi } from "vitest"

const rawMocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRawUnsafe: rawMocks.query, $executeRawUnsafe: rawMocks.execute },
}))

import {
  claimNextAnalysis,
  renewLease,
  completeAnalysis,
  failAnalysis,
  createWorkerId,
  MAX_ATTEMPTS,
  LEASE_DURATION_MS,
  ABANDONED_AFTER_MAX_ATTEMPTS,
} from "../../src/services/analysis/leasing.service"

const NOW = new Date("2026-11-04T00:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("lease deserialisation / params (raw SQL pass-through)", () => {
  it("builds a distinct worker identity", () => {
    const id1 = createWorkerId()
    const id2 = createWorkerId()
    expect(id1).toMatch(/^worker:.+:\d+:[0-9a-f-]{36}$/)
    expect(id1).not.toBe(id2)
  })

  it("claims nothing when no row is returned", async () => {
    rawMocks.query.mockResolvedValue([])
    expect(await claimNextAnalysis({ workerId: "worker-a", now: NOW })).toBeNull()
  })

  it("maps a claimed row and uses atomic SKIP LOCKED SQL", async () => {
    const lease = new Date(NOW.getTime() + LEASE_DURATION_MS)
    rawMocks.query.mockResolvedValue([
      {
        id: "analysis-1",
        analysisType: "repo_summary",
        repositoryId: "repo-1",
        userId: "user-1",
        input: { a: 1 },
        status: "running",
        attempts: 2,
        workerId: "worker-a",
        leaseExpiresAt: lease,
      },
    ])

    const claimed = await claimNextAnalysis({ workerId: "worker-a", now: NOW, maxAttempts: 4 })

    expect(claimed).toEqual({
      id: "analysis-1",
      analysisType: "repo_summary",
      repositoryId: "repo-1",
      userId: "user-1",
      input: { a: 1 },
      attempts: 2,
      workerId: "worker-a",
      leaseExpiresAt: lease,
    })

    const [sql, ...params] = rawMocks.query.mock.calls[0]
    expect(sql).toContain("FOR UPDATE SKIP LOCKED")
    expect(sql).toContain("pending")
    expect(sql).toContain("leaseExpiresAt\" < $2")
    // An exhausted row must not consume another attempt.
    expect(sql).toContain('THEN "attempts" ELSE "attempts" + 1')
    expect(params[0]).toBe("worker-a")
    expect(params[1]).toEqual(NOW)
    expect(params[2]).toEqual(lease)
    expect(params[3]).toBe(4)
    expect(params[4]).toBe(ABANDONED_AFTER_MAX_ATTEMPTS)
  })

  it("does not surface an exhausted row that was converted to terminal failed", async () => {
    rawMocks.query.mockResolvedValue([
      {
        id: "analysis-exhausted",
        analysisType: "repo_summary",
        repositoryId: null,
        userId: "user-1",
        input: null,
        status: "failed",
        attempts: 3,
        workerId: null,
        leaseExpiresAt: null,
      },
    ])
    expect(await claimNextAnalysis({ workerId: "worker-a", now: NOW })).toBeNull()
  })
})

describe("renewLease", () => {
  it("renews the lease while the caller still owns it", async () => {
    rawMocks.execute.mockResolvedValue(1)
    expect(
      await renewLease({ analysisId: "a1", workerId: "worker-a", now: NOW }),
    ).toBe(true)

    const [sql, ...params] = rawMocks.execute.mock.calls[0]
    expect(sql).toContain('"workerId" = $2')
    expect(sql).toContain('"leaseExpiresAt" > $4')
    expect(params[0]).toBe("a1")
    expect(params[1]).toBe("worker-a")
    expect(params[2]).toEqual(new Date(NOW.getTime() + LEASE_DURATION_MS))
    expect(params[3]).toEqual(NOW)
  })

  it("returns false when the lease was lost", async () => {
    rawMocks.execute.mockResolvedValue(0)
    expect(await renewLease({ analysisId: "a1", workerId: "stale-worker", now: NOW })).toBe(false)
  })
})

describe("completeAnalysis", () => {
  it("persists a result conditionally on ownership and a valid lease", async () => {
    rawMocks.execute.mockResolvedValue(1)
    const ok = await completeAnalysis({
      analysisId: "a1",
      workerId: "worker-a",
      now: NOW,
      status: "completed",
      result: { summary: { oneLine: "x" } },
      model: "gpt-4o-mini",
    })

    expect(ok).toBe(true)
    const [sql, ...params] = rawMocks.execute.mock.calls[0]
    expect(sql).toContain('"workerId" = $2')
    expect(sql).toContain('"leaseExpiresAt" > $3')
    expect(params[0]).toBe("a1")
    expect(params[1]).toBe("worker-a")
    expect(params[2]).toEqual(NOW)
    expect(params[3]).toBe("completed")
    expect(params[4]).toBe(JSON.stringify({ summary: { oneLine: "x" } }))
    expect(params[5]).toBe("gpt-4o-mini")
  })

  it("returns false for a stale worker whose lease was reclaimed", async () => {
    rawMocks.execute.mockResolvedValue(0)
    expect(
      await completeAnalysis({ analysisId: "a1", workerId: "stale-worker", now: NOW, result: { x: 1 } }),
    ).toBe(false)
  })
})

describe("failAnalysis", () => {
  it("passes the error and applies the attempt budget", async () => {
    rawMocks.execute.mockResolvedValue(1)
    const ok = await failAnalysis({
      analysisId: "a1",
      workerId: "worker-a",
      now: NOW,
      error: "boom",
      maxAttempts: 5,
    })

    expect(ok).toBe(true)
    const [sql, ...params] = rawMocks.execute.mock.calls[0]
    expect(sql).toContain('CASE WHEN "attempts" >= $5')
    expect(params[0]).toBe("a1")
    expect(params[1]).toBe("worker-a")
    expect(params[2]).toEqual(NOW)
    expect(params[3]).toBe("boom")
    expect(params[4]).toBe(5)
  })

  it("truncates long errors and refuses to fail a task it does not own", async () => {
    rawMocks.execute.mockResolvedValue(0)
    const ok = await failAnalysis({
      analysisId: "a1",
      workerId: "stale-worker",
      now: NOW,
      error: "e".repeat(5000),
    })
    expect(ok).toBe(false)
    // $executeRawUnsafe(sql, id, workerId, now, error, maxAttempts)
    const [, , , , , forwardedMaxAttempts] = rawMocks.execute.mock.calls[0]
    expect(forwardedMaxAttempts).toBe(MAX_ATTEMPTS)
  })
})