import crypto from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  decryptToken,
  encryptToken,
  getTokenKeyStore,
  isEncryptedToken,
  keyIdOf,
  parseEncryptedToken,
  type TokenContext,
  type TokenKeyStore,
} from "@/lib/encryption"
import {
  accountsNeedingMigration,
  classifyTokenValue,
  migrateAccounts,
  tokenFieldStatus,
} from "../../scripts/migrate-token-encryption.mjs"

const CURRENT_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
const PREVIOUS_KEY = Buffer.from("abcdef0123456789abcdef0123456789", "utf8")

const TOKEN_FIELDS = ["access_token", "refresh_token"]

let savedKey: string | undefined
let savedPrevKey: string | undefined

beforeEach(() => {
  savedKey = process.env.TOKEN_ENCRYPTION_KEY
  savedPrevKey = process.env.TOKEN_ENCRYPTION_KEY_PREV
  process.env.TOKEN_ENCRYPTION_KEY = CURRENT_KEY.toString("base64")
  delete process.env.TOKEN_ENCRYPTION_KEY_PREV
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY
  else process.env.TOKEN_ENCRYPTION_KEY = savedKey
  if (savedPrevKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREV
  else process.env.TOKEN_ENCRYPTION_KEY_PREV = savedPrevKey
})

/** Builds a store whose *current* key is `key` (no previous). */
function storeWithKey(key: Buffer): TokenKeyStore {
  return { current: key, currentKeyId: keyIdOf(key) }
}

/** Produces a genuine legacy v1 envelope (no AAD). */
function encryptV1(plaintext: string, key: Buffer = CURRENT_KEY): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `enc:v1:${keyIdOf(key)}:${Buffer.concat([iv, authTag, ciphertext]).toString("base64")}`
}

/** Produces a v2 envelope with an arbitrary *current* key (used to simulate a rotated-out key). */
function encryptV2WithKey(plaintext: string, key: Buffer, context: TokenContext): string {
  return encryptToken(plaintext, context, storeWithKey(key))
}

function accountRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: `user-${id}`,
    provider: "github",
    providerAccountId: id,
    access_token: null,
    refresh_token: null,
    ...overrides,
  }
}

function contextFor(id: string, field: "access_token" | "refresh_token"): TokenContext {
  return { provider: "github", providerAccountId: id, userId: `user-${id}`, field }
}

/** CAS-faithful Prisma mock that only applies an update when the stored value still matches. */
function makePrisma(initialRows: Array<Record<string, unknown>>) {
  let rows = [...initialRows]
  const updateMany = vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0
    rows = rows.map((row) => {
      if (row.id !== where.id) return row
      const matches = TOKEN_FIELDS.every(
        (field) => where[field] === undefined || row[field] === where[field],
      )
      if (!matches) return row
      count += 1
      return { ...row, ...data }
    })
    return { count }
  })
  const findMany = vi.fn(async () => [...rows])
  return {
    prisma: { account: { findMany, updateMany } },
    getRows: () => rows,
    findMany,
    updateMany,
  }
}

describe("migration classification", () => {
  it("classifies values as empty / already encrypted / plaintext", () => {
    expect(classifyTokenValue(null)).toBe("empty")
    expect(classifyTokenValue("")).toBe("empty")
    expect(classifyTokenValue(`enc:v1:k12345:${Buffer.from("x").toString("base64")}`)).toBe("encrypted")
    expect(classifyTokenValue(`enc:v2:k12345:${Buffer.from("x").toString("base64")}`)).toBe("encrypted")
    expect(classifyTokenValue("ghp_plaintext_123")).toBe("plaintext")
  })

  it("classifies detailed per-field status for the migration tool", () => {
    const store = getTokenKeyStore()
    const v1 = encryptV1("gho_legacy_v1")
    const current = encryptToken("ghp_current", contextFor("a", "access_token"))
    const previous = encryptV2WithKey("ghp_old_key", PREVIOUS_KEY, contextFor("a", "access_token"))
    const unknown = `enc:v2:zzzzzz:${Buffer.from(crypto.randomBytes(28)).toString("base64")}`

    expect(tokenFieldStatus(null, store)).toBe("empty")
    expect(tokenFieldStatus("ghp_plaintext", store)).toBe("plaintext")
    expect(tokenFieldStatus(v1, store)).toBe("v1")
    expect(tokenFieldStatus(current, store)).toBe("current")
    expect(tokenFieldStatus(previous, store)).toBe("unknown-key") // previous not configured yet

    process.env.TOKEN_ENCRYPTION_KEY_PREV = PREVIOUS_KEY.toString("base64")
    const storeWithPrev = getTokenKeyStore()
    expect(tokenFieldStatus(previous, storeWithPrev)).toBe("previous")
    expect(tokenFieldStatus(unknown, storeWithPrev)).toBe("unknown-key")
    expect(tokenFieldStatus("enc:v9:zzzz", storeWithPrev)).toBe("malformed")
  })

  it("picks accounts that still hold plaintext, v1, or old-key tokens", () => {
    const store = getTokenKeyStore()
    const rows = [
      accountRow("a", { access_token: "gho_plain_1" }),
      accountRow("b", { access_token: encryptV1("gho_legacy_v1") }),
      accountRow("c", { access_token: encryptToken("ghp_current", contextFor("c", "access_token")) }),
      accountRow("d", { refresh_token: null }),
    ]
    const affected = accountsNeedingMigration(rows, store) as Array<{
      id: string
      fields: string[]
      actions: Record<string, string>
    }>
    expect(affected.map((account) => account.id)).toEqual(["a", "b"])
    expect(affected[0].fields).toEqual(["access_token"])
    expect(affected[0].actions.access_token).toBe("encrypt")
    expect(affected[1].actions.access_token).toBe("upgrade")
  })
})

describe("migrateAccounts dry-run", () => {
  it("reports pending tokens and writes nothing", async () => {
    const { prisma, updateMany } = makePrisma([
      accountRow("a", { access_token: "gho_plain_1", refresh_token: "ghr_plain_1" }),
      accountRow("b", {
        access_token: encryptToken("ghp_current", contextFor("b", "access_token")),
        refresh_token: encryptToken("ghr_current", contextFor("b", "refresh_token")),
      }),
      accountRow("c", {}),
    ])

    const result = await migrateAccounts(prisma)

    expect(result.scanned).toBe(3)
    expect(result.empty).toBe(2)
    expect(result.plaintext).toBe(2)
    expect(result.current).toBe(2)
    expect(result.pending).toBe(2)
    expect(result.affected.map((account) => account.id)).toEqual(["a"])
    expect(updateMany).not.toHaveBeenCalled()
  })
})

describe("migrateAccounts execute", () => {
  it("encrypts plaintext tokens as v2 and is idempotent on re-run", async () => {
    const { prisma, updateMany, getRows } = makePrisma([
      accountRow("a", { access_token: "gho_plain_1", refresh_token: "ghr_plain_1" }),
      accountRow("b", { access_token: "ghp_plain_2" }),
    ])

    const first = await migrateAccounts(prisma, { execute: true })
    expect(first.pending).toBe(3)
    expect(updateMany).toHaveBeenCalledTimes(3)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a", access_token: "gho_plain_1" },
      }),
    )

    const rows = getRows()
    const a = rows.find((row) => row.id === "a")!
    expect(isEncryptedToken(a.access_token as string)).toBe(true)
    expect(isEncryptedToken(a.refresh_token as string)).toBe(true)
    expect(parseEncryptedToken(a.access_token as string)?.version).toBe("v2")
    expect(decryptToken(a.access_token as string, contextFor("a", "access_token"))).toBe("gho_plain_1")
    expect(decryptToken(a.refresh_token as string, contextFor("a", "refresh_token"))).toBe("ghr_plain_1")

    // Re-running is a no-op: nothing pending, no writes.
    const second = await migrateAccounts(prisma, { execute: true })
    expect(second.pending).toBe(0)
    expect(second.current).toBe(3)
    expect(second.affected).toEqual([])
    expect(updateMany).toHaveBeenCalledTimes(3)
  })

  it("upgrades legacy v1 ciphertext to AAD-bound v2 with the account context", async () => {
    const v1 = encryptV1("gho_legacy_v1")
    const { prisma, updateMany, getRows } = makePrisma([
      accountRow("a", { access_token: v1 }),
    ])

    const dryRun = await migrateAccounts(prisma)
    expect(dryRun.v1).toBe(1)
    expect(dryRun.affected[0]).toMatchObject({ id: "a", actions: { access_token: "upgrade" } })

    const result = await migrateAccounts(prisma, { execute: true })
    expect(result.v1).toBe(1)
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a", access_token: v1 } }),
    )

    const migrated = getRows()[0].access_token as string
    expect(parseEncryptedToken(migrated)?.version).toBe("v2")
    expect(decryptToken(migrated, contextFor("a", "access_token"))).toBe("gho_legacy_v1")
  })

  it("rotates old-key v2 ciphertext onto the current key", async () => {
    process.env.TOKEN_ENCRYPTION_KEY_PREV = PREVIOUS_KEY.toString("base64")
    const oldCipher = encryptV2WithKey("gho_rotated", PREVIOUS_KEY, contextFor("a", "access_token"))
    const { prisma, updateMany, getRows } = makePrisma([
      accountRow("a", { access_token: oldCipher }),
    ])

    const dryRun = await migrateAccounts(prisma)
    expect(dryRun.previous).toBe(1)
    expect(dryRun.affected[0]).toMatchObject({ id: "a", actions: { access_token: "rotate" } })

    const result = await migrateAccounts(prisma, { execute: true })
    expect(result.previous).toBe(1)
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a", access_token: oldCipher } }),
    )

    const migrated = getRows()[0].access_token as string
    const parts = parseEncryptedToken(migrated)
    expect(parts?.version).toBe("v2")
    expect(parts?.keyId).toBe(getTokenKeyStore().currentKeyId)
    expect(decryptToken(migrated, contextFor("a", "access_token"))).toBe("gho_rotated")
  })

  it("does not write unknown-key / malformed values", async () => {
    const unknown = `enc:v2:zzzzzz:${Buffer.from(crypto.randomBytes(28)).toString("base64")}`
    const { prisma, updateMany } = makePrisma([
      accountRow("a", { access_token: unknown }),
      accountRow("b", { access_token: "enc:v9:zzzz" }),
    ])

    const result = await migrateAccounts(prisma, { execute: true })
    expect(result.unknownKey).toBe(1)
    expect(result.malformed).toBe(1)
    expect(result.unhandled.map((u) => u.reason)).toEqual(["unknown-key", "malformed"])
    expect(result.affected).toEqual([])
    expect(updateMany).not.toHaveBeenCalled()
  })
})

describe("migrateAccounts CAS write-back", () => {
  it("detects concurrent field changes and does not clobber them", async () => {
    const { prisma, updateMany } = makePrisma([
      accountRow("a", { access_token: "gho_plain_1", refresh_token: "ghr_plain_1" }),
    ])
    // Simulate a concurrent writer: the CAS update matches nothing.
    updateMany.mockResolvedValue({ count: 0 })

    const result = await migrateAccounts(prisma, { execute: true })
    expect(result.conflicts).toContainEqual({ id: "a", field: "access_token" })
    expect(result.conflicts).toContainEqual({ id: "a", field: "refresh_token" })

    // Every write still went through the CAS predicate keyed on the old value.
    for (const call of updateMany.mock.calls) {
      const { where } = call[0]
      expect(where.id).toBe("a")
      expect(where.access_token === "gho_plain_1" || where.refresh_token === "ghr_plain_1").toBe(true)
      expect(call[0].data.access_token).not.toBe("gho_plain_1")
    }
  })

  it("CAS predicate compares the old ciphertext when rotating", async () => {
    process.env.TOKEN_ENCRYPTION_KEY_PREV = PREVIOUS_KEY.toString("base64")
    const oldCipher = encryptV2WithKey("gho_rotated", PREVIOUS_KEY, contextFor("a", "access_token"))
    const updateMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
      expect(args.where.access_token).toBe(oldCipher)
      return { count: 1 }
    })
    const prisma = {
      account: {
        findMany: vi.fn(async () => [accountRow("a", { access_token: oldCipher })]),
        updateMany,
      },
    }

    await migrateAccounts(prisma, { execute: true })
    expect(updateMany).toHaveBeenCalled()
  })
})