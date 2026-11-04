#!/usr/bin/env node
/**
 * Migrates Account `access_token` / `refresh_token` values at rest.
 *
 * Handles three cases per token field:
 * - plaintext legacy token           → encrypt into a v2 envelope bound to the
 *   owning Account via AAD (Account context cannot be copied across rows).
 * - `enc:v1:…` legacy ciphertext     → decrypt on the compat read path and
 *   re-encrypt into v2, so every stored token gains Account-context binding.
 * - v2 ciphertext from a rotated-out key (`TOKEN_ENCRYPTION_KEY_PREV`)
 *   → decrypt with the previous key and re-encrypt with the current key.
 *
 * Already-current v2 ciphertext is skipped, so re-running the script is safe
 * and never double-encrypts.
 *
 * Idempotent + repeatable. Requires `TOKEN_ENCRYPTION_KEY` (base64, 32 bytes).
 * Insecure keys (all-zero / constant-byte) are rejected, and a missing key
 * fails closed: the script writes nothing.
 *
 * Write-back is guarded by compare-and-swap (CAS): each field is only updated
 * when the stored value still equals the value this run read. If a concurrent
 * writer changed the field first, the update is skipped and reported as a
 * conflict rather than clobbering the newer value.
 *
 * Usage (from the repository root):
 *   npx tsx scripts/migrate-token-encryption.mjs             # dry-run: report only
 *   npx tsx scripts/migrate-token-encryption.mjs --execute   # migrate tokens
 *
 * Key rotation: set the new base64 key in `TOKEN_ENCRYPTION_KEY` and the old
 * one in `TOKEN_ENCRYPTION_KEY_PREV`; new writes use the new key while stored
 * values still decrypt via the previous key.
 */
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import prismaPackage from "@prisma/client"

import {
  decryptToken,
  encryptToken,
  getTokenKeyStore,
  isEncryptedToken,
  parseEncryptedToken,
} from "../src/lib/encryption.ts"

const { PrismaClient } = prismaPackage

/** @typedef {import("../src/lib/encryption.ts").TokenKeyStore} TokenKeyStore */
/** @typedef {import("../src/lib/encryption.ts").TokenField} TokenField */

const TOKEN_FIELDS = ["access_token", "refresh_token"]
const ACTIONABLE_STATUSES = ["plaintext", "v1", "previous"]

/** Classifies one stored token value: "empty", "encrypted", or "plaintext". */
export function classifyTokenValue(value) {
  if (value == null || value === "") return "empty"
  return isEncryptedToken(value) ? "encrypted" : "plaintext"
}

/**
 * Detailed per-field status using the resolved key store. Used to decide
 * whether a field needs encryption ("plaintext"), a v2 upgrade ("v1"), a key
 * rotation ("previous"), nothing ("current"), or cannot be handled at all
 * ("unknown-key" / "malformed" — not written).
 */
export function tokenFieldStatus(value, store) {
  if (value == null || value === "") return "empty"
  if (!isEncryptedToken(value)) return "plaintext"
  const parts = parseEncryptedToken(value)
  if (!parts) return "malformed"
  if (parts.version === "v1") {
    return parts.keyId === store.currentKeyId || parts.keyId === store.previousKeyId
      ? "v1"
      : "unknown-key"
  }
  if (parts.keyId === store.currentKeyId) return "current"
  if (store.previousKeyId && parts.keyId === store.previousKeyId) return "previous"
  return "unknown-key"
}

function actionForStatus(status) {
  if (status === "plaintext") return "encrypt"
  if (status === "v1") return "upgrade"
  return "rotate"
}

/**
 * Returns accounts that still need a migration, each annotated with the list
 * of fields that need action and a per-field `actions` map. Pure function for
 * easy testing.
 */
export function accountsNeedingMigration(accounts, store) {
  return accounts
    .filter((account) =>
      TOKEN_FIELDS.some((field) => ACTIONABLE_STATUSES.includes(tokenFieldStatus(account[field], store))),
    )
    .map((account) => {
      const fields = TOKEN_FIELDS.filter((field) =>
        ACTIONABLE_STATUSES.includes(tokenFieldStatus(account[field], store)),
      )
      return {
        ...account,
        fields,
        actions: Object.fromEntries(fields.map((field) => [field, actionForStatus(tokenFieldStatus(account[field], store))])),
      }
    })
}

function buildTokenContext(account, field) {
  return {
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    userId: account.userId,
    field,
  }
}

/** Encrypts a value after proving encrypt→decrypt roundtrips in memory. */
function roundtripVerified(plaintext, context, store) {
  const encrypted = encryptToken(plaintext, context, store)
  if (decryptToken(encrypted, context, store) !== plaintext) {
    throw new Error("Encryption roundtrip verification failed; refusing to write")
  }
  return encrypted
}

/**
 * Scans accounts and (optionally) migrates token fields.
 *
 * @param {object} prisma PrismaClient-like instance
 * @param {{ execute?: boolean, store?: TokenKeyStore }} [options]
 * @returns {Promise<{scanned: number, pending: number, empty: number,
 *   plaintext: number, v1: number, previous: number, current: number,
 *   unknownKey: number, malformed: number, alreadyEncrypted: number,
 *   affected: Array, conflicts: Array, unhandled: Array}>}
 */
export async function migrateAccounts(prisma, { execute = false, store } = {}) {
  const resolvedStore = store ?? getTokenKeyStore()

  const rows = await prisma.account.findMany({
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      userId: true,
      access_token: true,
      refresh_token: true,
    },
    orderBy: { id: "asc" },
  })

  const stats = { empty: 0, plaintext: 0, v1: 0, previous: 0, current: 0, unknownKey: 0, malformed: 0 }
  const unhandled = []

  for (const account of rows) {
    for (const field of TOKEN_FIELDS) {
      const status = tokenFieldStatus(account[field], resolvedStore)
      if (status === "empty") stats.empty += 1
      else if (status === "plaintext") stats.plaintext += 1
      else if (status === "v1") stats.v1 += 1
      else if (status === "previous") stats.previous += 1
      else if (status === "current") stats.current += 1
      else if (status === "unknown-key") {
        stats.unknownKey += 1
        unhandled.push({ id: account.id, field, reason: status })
      } else {
        stats.malformed += 1
        unhandled.push({ id: account.id, field, reason: status })
      }
    }
  }

  const affected = accountsNeedingMigration(rows, resolvedStore)
  const conflicts = []

  if (execute) {
    for (const account of affected) {
      for (const field of account.fields) {
        const oldValue = account[field]
        if (oldValue == null) continue
        const context = buildTokenContext(account, field)
        const plaintext = decryptToken(oldValue, context, resolvedStore)
        const newValue = roundtripVerified(plaintext, context, resolvedStore)
        const outcome = await prisma.account.updateMany({
          where: { id: account.id, [field]: oldValue },
          data: { [field]: newValue },
        })
        if (outcome.count !== 1) {
          conflicts.push({ id: account.id, field })
        }
      }
    }
  }

  return {
    scanned: rows.length,
    pending: stats.plaintext + stats.v1 + stats.previous,
    ...stats,
    alreadyEncrypted: stats.current,
    affected,
    conflicts,
    unhandled,
  }
}

function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  const entryPath = path.resolve(entry).replace(/\\/g, "/").toLowerCase()
  const selfPath = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase()
  return entryPath === selfPath
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const execute = process.argv.includes("--execute")

  if (!process.env.DATABASE_URL && existsSync(path.join(root, ".env"))) {
    process.loadEnvFile(path.join(root, ".env"))
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

  // Fail closed: without a valid, non-weak key the script refuses to run, so a
  // migration can never write plaintext tokens or use an insecure key.
  getTokenKeyStore()

  const prisma = new PrismaClient()
  try {
    const result = await migrateAccounts(prisma, { execute })

    console.log(`Scanned ${result.scanned} account(s).`)
    console.log(
      `Token fields: ${result.empty} empty, ${result.plaintext} plaintext pending, ` +
        `${result.v1} legacy v1 pending upgrade, ${result.previous} old-key pending rotation, ` +
        `${result.current} already current.`,
    )
    if (result.unhandled.length > 0) {
      console.log(
        `Unhandled (not written): ${result.unknownKey} unknown-key, ${result.malformed} malformed.`,
      )
    }

    if (result.affected.length === 0) {
      console.log("Nothing to migrate; all stored tokens are already encrypted with the current key (or missing).")
      return
    }

    for (const account of result.affected) {
      const details = account.fields.map((field) => `${field}(${account.actions[field]})`).join(", ")
      console.log(
        `${execute ? "[migrated] " : "[dry-run]   "} account ${account.id} (${account.provider}:${account.providerAccountId}): ${details}`,
      )
    }

    if (result.conflicts.length > 0) {
      console.log(
        `WARNING: ${result.conflicts.length} field(s) skipped because the stored value changed concurrently (CAS):`,
      )
      for (const conflict of result.conflicts) {
        console.log(`  account ${conflict.id} ${conflict.field}`)
      }
    }

    if (!execute) {
      console.log(`Dry run only (${result.pending} pending field(s)). Re-run with --execute to migrate.`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`[migrate-token-encryption] ${error.message}`)
    process.exitCode = 1
  })
}