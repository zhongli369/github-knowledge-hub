import { PrismaAdapter } from "@auth/prisma-adapter"
import type { Adapter, AdapterAccount } from "@auth/core/adapters"

import { prisma } from "@/lib/prisma"
import {
  decryptToken,
  encryptToken,
  isEncryptedToken,
  type TokenContext,
  type TokenField,
} from "@/lib/encryption"

/**
 * Wraps the official Prisma adapter so that every OAuth Account write goes
 * through the real Auth.js write path (`linkAccount`) but tokens are encrypted
 * at rest before they reach Prisma. The node_modules adapter itself is never
 * modified.
 *
 * Auth.js v5 has no `updateAccount` adapter method: account rows are created
 * via `linkAccount` and rotation is userland code. Wrapping `linkAccount`
 * covers the create path; refreshing tokens elsewhere must also route token
 * values through {@link encryptAccountTokens} so no plaintext is stored. Reads
 * through `getAccount` are decrypted before the account leaves the adapter.
 */

const ENCRYPTED_ACCOUNT_FIELDS = ["access_token", "refresh_token"] as const

type AdapterAccountTokens = AdapterAccount & {
  access_token?: string | null
  refresh_token?: string | null
}

/**
 * Builds the Account context that v2 ciphertext is cryptographically bound to.
 * The adapter owns the authoritative provider / providerAccountId / userId, so
 * it always supplies a full context for encrypt/decrypt.
 */
function tokenContextFor(account: AdapterAccountTokens, field: TokenField): TokenContext {
  return {
    provider: account.provider ?? "",
    providerAccountId: account.providerAccountId ?? "",
    userId: account.userId ?? "",
    field,
  }
}

/**
 * Returns a copy of an auth account with `access_token`/`refresh_token`
 * encrypted when they are present and not already encrypted. A missing
 * `TOKEN_ENCRYPTION_KEY` makes encryption throw, so a plaintext token is never
 * passed on (writes fail closed).
 */
export async function encryptAccountTokens(account: AdapterAccount): Promise<AdapterAccount> {
  const copy: AdapterAccountTokens = { ...account }
  for (const field of ENCRYPTED_ACCOUNT_FIELDS) {
    const value = copy[field]
    // Skip already-encrypted values so a re-run never double-encrypts.
    if (value && !isEncryptedToken(value)) {
      copy[field] = encryptToken(value, tokenContextFor(copy, field))
    }
  }
  return copy
}

/**
 * Returns a copy of an auth account with `access_token`/`refresh_token`
 * decrypted when they are ciphertext. Legacy plaintext tokens are left as-is.
 * v2 ciphertext requires the full Account context and fails closed when it is
 * missing.
 */
export async function decryptAccountTokens(account: AdapterAccount): Promise<AdapterAccount> {
  const copy: AdapterAccountTokens = { ...account }
  for (const field of ENCRYPTED_ACCOUNT_FIELDS) {
    const value = copy[field]
    if (value && isEncryptedToken(value)) {
      copy[field] = decryptToken(value, tokenContextFor(copy, field))
    }
  }
  return copy
}

/**
 * Builds an adapter from an existing one, intercepting the Account token read
 * and write paths:
 * - `linkAccount` encrypts tokens before they reach Prisma (the Auth.js v5
 *   account create path).
 * - `getAccount` decrypts tokens after a read, so every token that leaves the
 *   adapter is plaintext. Other adapter methods are left untouched.
 */
export function encryptingAdapter(base: Adapter): Adapter {
  return {
    ...base,
    async linkAccount(account: AdapterAccount) {
      const stored = await encryptAccountTokens(account)
      const result = await base.linkAccount!(stored)
      return result as AdapterAccount | null | undefined
    },
    async getAccount(providerAccountId, provider) {
      const account = await base.getAccount?.(providerAccountId, provider)
      return account ? decryptAccountTokens(account) : null
    },
  }
}

/** Encrypted Auth.js Prisma adapter backed by the project's Prisma client. */
export function encryptedPrismaAdapter(): Adapter {
  return encryptingAdapter(PrismaAdapter(prisma))
}