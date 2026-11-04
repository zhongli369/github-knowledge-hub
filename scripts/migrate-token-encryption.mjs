#!/usr/bin/env node
/**
 * Encrypts existing Account `access_token` / `refresh_token` values at rest.
 *
 * The app only ever wrote GitHub OAuth tokens, but this script is provider-
 * agnostic: every non-empty, non-encrypted token field is encrypted, which
 * keeps future decryption working for every stored value. Already-encrypted
 * values (`enc:v1:…`) are skipped, so re-running the script is safe and never
 * double-encrypts.
 *
 * Idempotent + repeatable. Requires `TOKEN_ENCRYPTION_KEY` (base64, 32 bytes).
 * If the key is missing the script fails closed and writes nothing.
 *
 * Usage (from the repository root):
 *   npx tsx scripts/migrate-token-encryption.mjs             # dry-run: report only
 *   npx tsx scripts/migrate-token-encryption.mjs --execute   # encrypt plaintext tokens
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
} from "../src/lib/encryption.ts"

const { PrismaClient } = prismaPackage

const TOKEN_FIELDS = ["access_token", "refresh_token"]

/** Classifies one stored token value: "empty", "encrypted", or "plaintext". */
export function classifyTokenValue(value) {
  if (value == null || value === "") return "empty"
  return isEncryptedToken(value) ? "encrypted" : "plaintext"
}

/**
 * Returns accounts that still hold plaintext tokens, each annotated with the
 * list of fields that need encryption. Pure function for easy testing.
 */
export function accountsNeedingMigration(accounts) {
  return accounts
    .filter((account) => TOKEN_FIELDS.some((field) => classifyTokenValue(account[field]) === "plaintext"))
    .map((account) => ({
      ...account,
      fields: TOKEN_FIELDS.filter((field) => classifyTokenValue(account[field]) === "plaintext"),
    }))
}

/** Encrypts a value after proving encrypt→decrypt roundtrips in memory. */
function roundtripVerified(value) {
  const encrypted = encryptToken(value)
  if (decryptToken(encrypted) !== value) {
    throw new Error("Encryption roundtrip verification failed; refusing to write")
  }
  return encrypted
}

/**
 * Scans accounts and (optionally) encrypts plaintext tokens.
 *
 * @param {object} prisma PrismaClient-like instance
 * @param {{ execute?: boolean }} [options]
 * @returns {Promise<{scanned: number, empty: number, alreadyEncrypted: number,
 *   pending: number, affected: Array<{id: string, fields: string[]}>}>}
 */
export async function migrateAccounts(prisma, { execute = false } = {}) {
  const rows = await prisma.account.findMany({
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      access_token: true,
      refresh_token: true,
    },
    orderBy: { id: "asc" },
  })

  const affected = accountsNeedingMigration(rows)
  let empty = 0
  let alreadyEncrypted = 0
  let pending = 0

  for (const account of rows) {
    for (const field of TOKEN_FIELDS) {
      const kind = classifyTokenValue(account[field])
      if (kind === "empty") empty += 1
      else if (kind === "encrypted") alreadyEncrypted += 1
      else pending += 1
    }
  }

  if (execute) {
    for (const account of affected) {
      const data = {}
      for (const field of account.fields) {
        data[field] = roundtripVerified(account[field])
      }
      await prisma.account.update({ where: { id: account.id }, data })
    }
  }

  return { scanned: rows.length, empty, alreadyEncrypted, pending, affected }
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

  // Fail closed: without a key the script refuses to run, so a migration can
  // never accidentally write plaintext tokens.
  getTokenKeyStore()

  const prisma = new PrismaClient()
  try {
    const result = await migrateAccounts(prisma, { execute })

    console.log(`Scanned ${result.scanned} account(s).`)
    console.log(`Token fields: ${result.empty} empty, ${result.alreadyEncrypted} already encrypted, ${result.pending} pending plaintext.`)

    if (result.affected.length === 0) {
      console.log("Nothing to do; all stored tokens are already encrypted (or missing).")
      return
    }

    for (const account of result.affected) {
      console.log(
        `${execute ? "[encrypted]" : "[dry-run]     "} account ${account.id} (${account.provider}:${account.providerAccountId}): ${account.fields.join(", ")}`,
      )
    }

    if (!execute) {
      console.log("Dry run only. Re-run with --execute to encrypt these tokens.")
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