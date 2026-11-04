import crypto from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { PrismaAdapter } from "@auth/prisma-adapter"
import type { AdapterAccount } from "@auth/core/adapters"

import { encryptingAdapter } from "@/lib/auth-adapter"
import { decryptToken, isEncryptedToken } from "@/lib/encryption"
import { createOctokit } from "@/lib/github/client"
import { migrateAccounts } from "../../scripts/migrate-token-encryption.mjs"

// Fake tokens, never real credentials.
const GITHUB_ACCESS_TOKEN = "gho_it_access_token_123456"
const GITHUB_REFRESH_TOKEN = "ghr_it_refresh_token_abc789"

function testDatabaseUrl(variable: string): string {
  const value = process.env[variable]
  if (!value) throw new Error(`${variable} is required`)
  const databaseName = new URL(value).pathname.slice(1)
  if (!/^gkh_test_[a-z]+_\d+_\d+$/.test(databaseName)) {
    throw new Error(`${variable} must point to an isolated gkh_test_* database`)
  }
  return value
}

const freshUrl = testDatabaseUrl("GKH_TEST_FRESH_DATABASE_URL")
const prisma = new PrismaClient({ datasources: { db: { url: freshUrl } } })

const TEST_KEY = crypto.randomBytes(32).toString("base64")
let savedKey: string | undefined
const createdUsers: string[] = []

async function createUser(): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const userId = `token-it-${suffix}`
  await prisma.user.create({
    data: { id: userId, email: `${userId}@example.invalid`, name: "Token IT" },
  })
  createdUsers.push(userId)
  return userId
}

beforeAll(() => {
  savedKey = process.env.TOKEN_ENCRYPTION_KEY
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY
})

afterAll(async () => {
  await prisma.account.deleteMany({ where: { userId: { in: createdUsers } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } })
  await prisma.$disconnect()
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY
  else process.env.TOKEN_ENCRYPTION_KEY = savedKey
})

describe("token encryption at rest (integration)", () => {
  it("stores ciphertext through the real Prisma Adapter linkAccount write path", async () => {
    const adapter = encryptingAdapter(PrismaAdapter(prisma))
    const userId = await createUser()
    const account: AdapterAccount = {
      userId,
      type: "oauth",
      provider: "github",
      providerAccountId: `${userId}-oauth`,
      access_token: GITHUB_ACCESS_TOKEN,
      refresh_token: GITHUB_REFRESH_TOKEN,
    }

    await adapter.linkAccount!(account)

    const stored = await prisma.account.findFirstOrThrow({
      where: { userId },
      select: { access_token: true, refresh_token: true },
    })
    expect(stored.access_token).not.toBe(GITHUB_ACCESS_TOKEN)
    expect(stored.refresh_token).not.toBe(GITHUB_REFRESH_TOKEN)
    expect(isEncryptedToken(stored.access_token!)).toBe(true)
    expect(isEncryptedToken(stored.refresh_token!)).toBe(true)

    expect(decryptToken(stored.access_token!)).toBe(GITHUB_ACCESS_TOKEN)
    expect(decryptToken(stored.refresh_token!)).toBe(GITHUB_REFRESH_TOKEN)

    // The app's real GitHub token use point can also read this account.
    const octokit = await createOctokit(userId)
    expect(octokit).toBeDefined()
  })

  it("decrypts legacy plaintext tokens through the GitHub client use point", async () => {
    const userId = await createUser()
    await prisma.account.create({
      data: {
        userId,
        type: "oauth",
        provider: "github",
        providerAccountId: `${userId}-legacy`,
        access_token: "ghp_legacy_plaintext_123",
        refresh_token: "ghr_legacy_plaintext_456",
      },
    })

    const row = await prisma.account.findFirstOrThrow({
      where: { userId },
      select: { access_token: true },
    })
    expect(row.access_token).toBe("ghp_legacy_plaintext_123")

    const octokit = await createOctokit(userId)
    expect(octokit).toBeDefined()
  })

  it("fails closed and writes nothing when TOKEN_ENCRYPTION_KEY is missing", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    const adapter = encryptingAdapter(PrismaAdapter(prisma))
    const userId = await createUser()
    try {
      await expect(
        adapter.linkAccount!({
          userId,
          type: "oauth",
          provider: "github",
          providerAccountId: `${userId}-nokey`,
          access_token: GITHUB_ACCESS_TOKEN,
        }),
      ).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/)

      expect(await prisma.account.count({ where: { userId } })).toBe(0)
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY
    }
  })

  it("migrates existing plaintext tokens once and is idempotent on re-run", async () => {
    const userId = await createUser()
    const accountId = `acc-${userId}-legacy`
    await prisma.account.create({
      data: {
        id: accountId,
        userId,
        type: "oauth",
        provider: "github",
        providerAccountId: `${userId}-migrate`,
        access_token: "ghp_legacy_migrate_456",
        refresh_token: "ghr_legacy_migrate_789",
      },
    })

    // Dry run leaves the database untouched.
    const dryRun = await migrateAccounts(prisma, { execute: false })
    expect(dryRun.pending).toBeGreaterThanOrEqual(2)
    const before = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { access_token: true },
    })
    expect(before.access_token).toBe("ghp_legacy_migrate_456")

    // Execute once: tokens are encrypted in place.
    await migrateAccounts(prisma, { execute: true })
    const migrated = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { access_token: true, refresh_token: true },
    })
    expect(isEncryptedToken(migrated.access_token!)).toBe(true)
    expect(decryptToken(migrated.access_token!)).toBe("ghp_legacy_migrate_456")
    expect(decryptToken(migrated.refresh_token!)).toBe("ghr_legacy_migrate_789")

    // Re-run: no further changes, no double encryption.
    const reRun = await migrateAccounts(prisma, { execute: true })
    expect(reRun.affected.some((account) => account.id === accountId)).toBe(false)
    const after = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { access_token: true },
    })
    expect(decryptToken(after.access_token!)).toBe("ghp_legacy_migrate_456")
  })
})