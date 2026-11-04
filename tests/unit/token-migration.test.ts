import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { decryptToken, isEncryptedToken } from "@/lib/encryption"
import {
  accountsNeedingMigration,
  classifyTokenValue,
  migrateAccounts,
} from "../../scripts/migrate-token-encryption.mjs"

const TEST_KEY_URL = Buffer.from("migration-test-key-0123456789abc", "utf8").toString("base64")

let savedKey: string | undefined

beforeEach(() => {
  savedKey = process.env.TOKEN_ENCRYPTION_KEY
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY_URL
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY
  else process.env.TOKEN_ENCRYPTION_KEY = savedKey
})

function accountRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "github",
    providerAccountId: id,
    access_token: null,
    refresh_token: null,
    ...overrides,
  }
}

describe("migration classification", () => {
  it("classifies values as empty / already encrypted / plaintext", () => {
    expect(classifyTokenValue(null)).toBe("empty")
    expect(classifyTokenValue("")).toBe("empty")
    expect(classifyTokenValue(`enc:v1:k12345:${Buffer.from("x").toString("base64")}`)).toBe("encrypted")
    expect(classifyTokenValue("ghp_plaintext_123")).toBe("plaintext")
  })

  it("picks accounts that still hold plaintext tokens", () => {
    const rows = [
      accountRow("a", { access_token: "gho_plain_1" }),
      accountRow("b", { access_token: `enc:v1:k12345:${Buffer.from("x").toString("base64")}` }),
      accountRow("c", { refresh_token: null }),
    ]
    const affected = accountsNeedingMigration(rows) as Array<{ id: string; fields: string[] }>
    expect(affected.map((account) => account.id)).toEqual(["a"])
    expect(affected[0].fields).toEqual(["access_token"])
  })
})

describe("migrateAccounts", () => {
  it("dry-run reports pending tokens and writes nothing", async () => {
    const rows = [
      accountRow("a", { access_token: "gho_plain_1", refresh_token: "ghr_plain_1" }),
      accountRow("b", { access_token: `enc:v1:k12345:${Buffer.from("x").toString("base64")}` }),
      accountRow("c", {}),
    ]
    const update = vi.fn(async ({ where, data }) => ({ ...where, ...data }))
    const prisma = { account: { findMany: vi.fn(async () => rows), update } }

    const result = await migrateAccounts(prisma)

    expect(result.scanned).toBe(3)
    expect(result.alreadyEncrypted).toBe(1)
    expect(result.pending).toBe(2)
    expect(result.affected.map((account) => account.id)).toEqual(["a"])
    expect(update).not.toHaveBeenCalled()
  })

  it("executes writes as ciphertext and is idempotent on re-run", async () => {
    let rows = [
      accountRow("a", { access_token: "gho_plain_1", refresh_token: "ghr_plain_1" }),
      accountRow("b", { access_token: "ghp_plain_2" }),
    ]
    const update = vi.fn(async ({ where, data }) => {
      rows = rows.map((row) => (row.id === where.id ? { ...row, ...data } : row))
      return { ...where, ...data }
    })
    const prisma = { account: { findMany: vi.fn(async () => rows), update } }

    const first = await migrateAccounts(prisma, { execute: true })
    expect(first.pending).toBe(3)
    expect(update).toHaveBeenCalledTimes(2)

    // What the DB now holds is ciphertext that decrypts back to the originals.
    const now = rows.find((row) => row.id === "a")!
    expect(isEncryptedToken(now.access_token!)).toBe(true)
    expect(isEncryptedToken(now.refresh_token!)).toBe(true)
    expect(decryptToken(now.access_token!)).toBe("gho_plain_1")
    expect(decryptToken(now.refresh_token!)).toBe("ghr_plain_1")

    // Re-running is a no-op: nothing pending, no writes.
    const second = await migrateAccounts(prisma, { execute: true })
    expect(second.pending).toBe(0)
    expect(second.alreadyEncrypted).toBe(3)
    expect(update).toHaveBeenCalledTimes(2)
  })
})