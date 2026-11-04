import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

// Keep embedding side effects deterministic and offline-safe: `extractFromFile`
// catches the failure, so asset creation still works without network.
vi.mock("@/lib/embeddings", () => ({
  embeddingsOpenAI: {
    embeddings: {
      create: () => {
        throw new Error("embedding network disabled in worker leasing tests")
      },
    },
  },
}))

import { prisma } from "@/lib/prisma"
import { extractFromFile } from "@/services/knowledge/extraction.service"
import {
  claimNextAnalysis,
  renewLease,
  completeAnalysis,
  failAnalysis,
  MAX_ATTEMPTS,
  ABANDONED_AFTER_MAX_ATTEMPTS,
} from "@/services/analysis/leasing.service"

const DASH = "worker-lease"

beforeAll(async () => {
  const databaseName = new URL(process.env.DATABASE_URL!).pathname.slice(1)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(databaseName)) {
    throw new Error("Worker leasing tests refuse to run outside an isolated fresh test database")
  }

  const now = new Date()
  await prisma.user.create({
    data: { id: `${DASH}-user`, name: "Worker Lease User", updatedAt: now },
  })
  await prisma.repository.create({
    data: {
      id: `${DASH}-repo`,
      githubId: 700001,
      owner: "worker",
      name: "lease-repo",
      fullName: "worker/lease-repo",
      description: "Isolated worker leasing fixture",
      url: "https://example.invalid/worker/lease-repo",
      language: "TypeScript",
      stars: 0,
      topics: [],
      userId: `${DASH}-user`,
      updatedAt: now,
    },
  })
})

afterEach(async () => {
  // Keep the queue deterministic for later tests: never leave a claimable task
  // behind. Other integration files use different id prefixes.
  await prisma.analysis.deleteMany({ where: { id: { startsWith: `${DASH}-` } } })
})

afterAll(async () => {
  await prisma.knowledgeAsset.deleteMany({ where: { repositoryId: `${DASH}-repo` } })
  await prisma.analysis.deleteMany({ where: { repositoryId: `${DASH}-repo` } })
  await prisma.repository.deleteMany({ where: { id: `${DASH}-repo` } })
  await prisma.user.deleteMany({ where: { id: `${DASH}-user` } })
  await prisma.$disconnect()
})

async function enqueue(analysisType: string, id: string): Promise<string> {
  await prisma.analysis.create({
    data: {
      id,
      analysisType,
      status: "pending",
      repositoryId: `${DASH}-repo`,
      userId: `${DASH}-user`,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  })
  return id
}

describe("PostgreSQL atomic worker claiming", () => {
  it("leases a single task to exactly one of two racing workers", async () => {
    const id = await enqueue("repo_summary", `${DASH}-claim-race`)

    const [a, b] = await Promise.all([
      claimNextAnalysis({ workerId: "worker-a" }),
      claimNextAnalysis({ workerId: "worker-b" }),
    ])

    const winners = [a, b].filter((x) => x !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.id).toBe(id)

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("running")
    expect(row.workerId).toBe(winners[0]!.workerId)
    expect(row.attempts).toBe(1)
    expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it("allows concurrent workers to claim distinct tasks", async () => {
    const id1 = await enqueue("repo_summary", `${DASH}-distinct-1`)
    const id2 = await enqueue("asset_extraction", `${DASH}-distinct-2`)

    const [a, b] = await Promise.all([
      claimNextAnalysis({ workerId: "worker-a" }),
      claimNextAnalysis({ workerId: "worker-b" }),
    ])

    const claims = [a, b].filter((x) => x !== null)
    expect(claims).toHaveLength(2)
    expect(new Set(claims.map((claim) => claim!.id))).toEqual(new Set([id1, id2]))
  })

  it("never reclaims a running task while its lease is valid", async () => {
    const id = await enqueue("repo_summary", `${DASH}-valid-lease`)
    await claimNextAnalysis({ workerId: "worker-a" })

    expect(await claimNextAnalysis({ workerId: "worker-b" })).toBeNull()

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(row.workerId).toBe("worker-a")
    expect(row.status).toBe("running")
  })

  it("reclaims a running task whose lease expired and increments attempts", async () => {
    const id = await enqueue("repo_summary", `${DASH}-expired`)
    await claimNextAnalysis({ workerId: "worker-a" })
    await prisma.analysis.update({
      where: { id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000), error: "previous attempt failed" },
    })

    const reclaimed = await claimNextAnalysis({ workerId: "worker-b" })
    expect(reclaimed).not.toBeNull()
    expect(reclaimed!.id).toBe(id)

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(row.workerId).toBe("worker-b")
    expect(row.attempts).toBe(2)
    expect(row.error).toBeNull()
  })

  it("reclaims a running task with no lease timestamp", async () => {
    const id = await enqueue("repo_summary", `${DASH}-null-lease`)
    await prisma.analysis.update({
      where: { id },
      data: { status: "running", workerId: "crashed-worker", leaseExpiresAt: null },
    })

    const reclaimed = await claimNextAnalysis({ workerId: "recovery-worker" })
    expect(reclaimed).toMatchObject({ id, workerId: "recovery-worker", attempts: 1 })
  })

  it("terminally fails after max attempts and cannot loop forever", async () => {
    const id = await enqueue("repo_summary", `${DASH}-max-attempts`)
    await prisma.analysis.update({ where: { id }, data: { attempts: MAX_ATTEMPTS - 1 } })

    const claimed = await claimNextAnalysis({ workerId: "worker-a" })
    expect(claimed).not.toBeNull()

    const rowAfterClaim = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(rowAfterClaim.attempts).toBe(MAX_ATTEMPTS)

    const failed = await failAnalysis({ analysisId: id, workerId: "worker-a", error: "poisoned" })
    expect(failed).toBe(true)

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("failed")
    expect(row.leaseExpiresAt).toBeNull()

    // The queue is now drained for this task.
    expect(await claimNextAnalysis({ workerId: "worker-b" })).toBeNull()
  })

  it("converts an exhausted lease-expired task to terminal failed instead of re-claiming", async () => {
    const id = await enqueue("repo_summary", `${DASH}-exhausted`)
    await prisma.analysis.update({
      where: { id },
      data: {
        status: "running",
        attempts: MAX_ATTEMPTS,
        workerId: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    })

    expect(await claimNextAnalysis({ workerId: "worker-b" })).toBeNull()

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("failed")
    expect(row.error).toBe(ABANDONED_AFTER_MAX_ATTEMPTS)
    expect(row.leaseExpiresAt).toBeNull()
    // Exhausted conversion must not consume another attempt beyond the cap.
    expect(row.attempts).toBe(MAX_ATTEMPTS)
  })
})

describe("stale worker and lease renewal semantics", () => {
  it("prevents a stale worker from overwriting the newer worker's result", async () => {
    const id = await enqueue("repo_summary", `${DASH}-stale`)
    await claimNextAnalysis({ workerId: "worker-a" })

    // Lease expires; worker-b reclaims.
    await prisma.analysis.update({
      where: { id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    })
    const claimedB = await claimNextAnalysis({ workerId: "worker-b" })
    expect(claimedB).not.toBeNull()

    // Stale worker-a fails both terminal writes.
    expect(
      await completeAnalysis({
        analysisId: id,
        workerId: "worker-a",
        status: "completed",
        result: { summary: "stale result" },
      }),
    ).toBe(false)
    expect(
      await failAnalysis({ analysisId: id, workerId: "worker-a", error: "stale error" }),
    ).toBe(false)

    const row = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("running")
    expect(row.workerId).toBe("worker-b")
    expect(row.result).toBeNull()
    expect(row.error).toBeNull()

    expect(
      await completeAnalysis({
        analysisId: id,
        workerId: "worker-b",
        status: "completed",
        result: { summary: "fresh result" },
      }),
    ).toBe(true)

    const completed = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(completed.status).toBe("completed")
    expect(completed.result).toEqual({ summary: "fresh result" })
  })

  it("rejects an old fencing token even when the worker identity is reused", async () => {
    const id = await enqueue("repo_summary", `${DASH}-fencing`)
    const first = await claimNextAnalysis({ workerId: "reused-worker" })
    await prisma.analysis.update({
      where: { id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    })
    const second = await claimNextAnalysis({ workerId: "reused-worker" })

    expect(first!.attempts).toBe(1)
    expect(second!.attempts).toBe(2)
    expect(
      await completeAnalysis({
        analysisId: id,
        workerId: "reused-worker",
        fencingToken: first!.attempts,
        result: { summary: "stale" },
      }),
    ).toBe(false)
    expect(
      await completeAnalysis({
        analysisId: id,
        workerId: "reused-worker",
        fencingToken: second!.attempts,
        result: { summary: "fresh" },
      }),
    ).toBe(true)
  })

  it("renews the lease while owned and refuses a stale renewal", async () => {
    const id = await enqueue("repo_summary", `${DASH}-heartbeat`)
    const claimed = await claimNextAnalysis({ workerId: "worker-a", leaseDurationMs: 10_000 })
    const originalLease = claimed!.leaseExpiresAt.getTime()

    expect(await renewLease({ analysisId: id, workerId: "worker-a", leaseDurationMs: 10_000 })).toBe(true)
    const renewed = await prisma.analysis.findUniqueOrThrow({ where: { id } })
    expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(originalLease)

    // After expiry + reclaim, the old worker can no longer renew.
    await prisma.analysis.update({
      where: { id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    })
    await claimNextAnalysis({ workerId: "worker-b" })
    expect(await renewLease({ analysisId: id, workerId: "worker-a" })).toBe(false)
  })
})

describe("knowledge asset idempotency on re-claim", () => {
  it("never duplicates a knowledge asset when two worker runs extract the same file concurrently", async () => {
    const sourcePath = "worker-lease/example.ts"
    const content = "const x = 1 // worker leasing idempotency sample content ".repeat(4)

    // Two workers racing on the same (repositoryId, sourcePath). The unique
    // index on KnowledgeAsset(repositoryId, sourcePath) — which the init
    // migration already created — lets exactly one INSERT win; the other gets
    // Prisma P2002 and is swallowed by extractFromFile's duplicate-skip.
    const [first, second] = await Promise.all([
      extractFromFile(`${DASH}-user`, `${DASH}-repo`, sourcePath, content, "TypeScript"),
      extractFromFile(`${DASH}-user`, `${DASH}-repo`, sourcePath, content, "TypeScript"),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect([first, second].filter((x) => x === null)).toHaveLength(1)

    const assets = await prisma.knowledgeAsset.findMany({
      where: { repositoryId: `${DASH}-repo`, sourcePath },
    })
    expect(assets).toHaveLength(1)
  })
})