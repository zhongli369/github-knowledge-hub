import crypto from "node:crypto"

/**
 * Encrypted token envelope formats:
 *
 *   enc:v1:<keyId>:<base64( iv || authTag || ciphertext )>
 *   enc:v2:<keyId>:<base64( iv || authTag || ciphertext )>
 *
 * - `v1` is the legacy ciphertext format. It was written before Account
 *   context binding existed and carries no AAD. It is still decrypted for
 *   backwards compatibility but must never be produced by new writes.
 * - `v2` is the current format. The AES-256-GCM operation is bound to the
 *   owning Account through authenticated additional data (AAD) derived from
 *   `{ provider, providerAccountId, userId, field }`. A ciphertext copied to a
 *   different Account (or swapped between `access_token` / `refresh_token`)
 *   fails authenticated decryption instead of silently decrypting.
 * - `<keyId>` is a short fingerprint of the exact AES-256 key that produced
 *   the ciphertext, so key rotation works without touching already-stored
 *   tokens and without guessing which key to try.
 *
 * Plaintext GitHub tokens that were stored before encryption was enabled
 * (`gho_…`, `ghp_…`, `ghu_…`, `ghs_…`, `ghr_…`, `github_pat_…`) are still
 * returned as-is for backwards compatibility; anything that is neither a
 * known plaintext GitHub token nor a supported encrypted envelope is treated
 * as corrupt and fails loudly instead of being silently passed along.
 *
 * Key material:
 * - `TOKEN_ENCRYPTION_KEY`        – base64-encoded 32-byte key, used for
 *   encryption and decryption. Writes fail closed when it is missing, and
 *   insecure keys (all-zero / constant-byte) are rejected outright.
 * - `TOKEN_ENCRYPTION_KEY_PREV`   – optional base64-encoded 32-byte *old* key
 *   that is accepted for decryption only, so a key rotation does not orphan
 *   already-encrypted tokens.
 */

export const TOKEN_ENVELOPE_V1 = "enc:v1:"
export const TOKEN_ENVELOPE_V2 = "enc:v2:"
/** Legacy alias kept for backwards compatibility with the v1 envelope prefix. */
export const TOKEN_CIPHER_PREFIX = TOKEN_ENVELOPE_V1

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16
const KEYID_ENCODED_CHARS = 6 // 4 bytes of key fingerprint → 6 base64url chars

const CURRENT_KEY_ENV = "TOKEN_ENCRYPTION_KEY"
const PREVIOUS_KEY_ENV = "TOKEN_ENCRYPTION_KEY_PREV"

const GITHUB_TOKEN_PATTERN = /^(gh[opurs]_|github_pat_)/i

/** Token fields that are encrypted at rest. */
export type TokenField = "access_token" | "refresh_token"

/**
 * The Account identity a token belongs to. v2 ciphertext is cryptographically
 * bound to this context via AAD, so the exact same context must be supplied to
 * decrypt the value.
 */
export interface TokenContext {
  provider: string
  providerAccountId: string
  userId: string
  field: TokenField
}

export interface TokenKeyStore {
  /** Primary key: used to encrypt new values and to decrypt values it produced. */
  current: Buffer
  /** Optional previous key: accepted for decryption only (key rotation). */
  previous?: Buffer
  /** Short key id of {@link current}. */
  currentKeyId: string
  /** Short key id of {@link previous}, if set. */
  previousKeyId?: string
}

export class TokenDecryptionError extends Error {
  override readonly name = "TokenDecryptionError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Deterministic AAD for a v2 token. The fixed prefix (domain + purpose)
 * prevents cross-application/cross-purpose use of the same key material, and
 * the JSON encoding keeps the payload unambiguous regardless of the characters
 * present in the account identifiers.
 */
export function aadFor(context: TokenContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      "github-knowledge-hub",
      "account-token-v2",
      context.provider,
      context.providerAccountId,
      context.userId,
      context.field,
    ]),
    "utf8",
  )
}

/** Throws unless {@link context} is a complete, non-empty Account context. */
function requireContext(
  context: TokenContext | undefined,
  operation: string,
  version: string,
): TokenContext {
  if (!context) {
    throw new TokenDecryptionError(
      `${operation} requires Account context for ${version} ciphertext ` +
        "(provider, providerAccountId, userId and field); refusing to proceed without it",
    )
  }
  for (const key of ["provider", "providerAccountId", "userId", "field"] as const) {
    const value = context[key]
    if (typeof value !== "string" || value.length === 0) {
      throw new TokenDecryptionError(
        `${operation} requires a non-empty Account context field "${key}" for ${version} ciphertext`,
      )
    }
  }
  return context
}

/** Decodes and validates a base64-encoded 32-byte key from the environment. */
function decodeKey(raw: string, envName: string): Buffer {
  const key = Buffer.from(raw, "base64")
  if (key.length !== 32) {
    throw new Error(
      `${envName} must be a base64-encoded 256-bit key (decoded length must be 32 bytes, got ${key.length})`,
    )
  }
  if (key.every((byte) => byte === 0)) {
    throw new Error(`${envName} is an all-zero key; refusing to use an insecure key`)
  }
  if (key.every((byte) => byte === key[0])) {
    throw new Error(`${envName} is a constant-byte key; refusing to use an insecure key`)
  }
  return key
}

/** Short non-secret fingerprint of a key, used as the ciphertext key id. */
export function keyIdOf(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("base64url").slice(0, KEYID_ENCODED_CHARS)
}

/**
 * Resolves the configured keys. Throws when the primary key is missing or
 * insecure so that token *writes* fail closed (no plaintext is ever stored and
 * no weak key is ever used).
 */
export function getTokenKeyStore(env: NodeJS.ProcessEnv = process.env): TokenKeyStore {
  const rawCurrent = env[CURRENT_KEY_ENV]
  if (!rawCurrent) {
    throw new Error(
      `${CURRENT_KEY_ENV} is not set. Refusing to encrypt/decrypt GitHub tokens; no plaintext token will be written.`,
    )
  }
  const current = decodeKey(rawCurrent, CURRENT_KEY_ENV)
  const rawPrevious = env[PREVIOUS_KEY_ENV]
  const previous = rawPrevious ? decodeKey(rawPrevious, PREVIOUS_KEY_ENV) : undefined
  return {
    current,
    previous,
    currentKeyId: keyIdOf(current),
    previousKeyId: previous ? keyIdOf(previous) : undefined,
  }
}

/** True when a stored value uses any supported (or future) `<enc:v…>` envelope. */
export function isEncryptedToken(value: string): boolean {
  return value.startsWith("enc:v")
}

/** True when a value is a legacy plaintext GitHub token stored before encryption. */
export function isPlaintextGitHubToken(value: string): boolean {
  return GITHUB_TOKEN_PATTERN.test(value)
}

export interface EncryptedTokenParts {
  version: "v1" | "v2"
  keyId: string
  payload: string
}

/**
 * Parses a supported encrypted envelope. Returns null for values that are not
 * `<enc:v1:…>` / `<enc:v2:…>` envelopes (including unknown future versions).
 */
export function parseEncryptedToken(value: string): EncryptedTokenParts | null {
  const supported: Array<[string, "v1" | "v2"]> = [
    [TOKEN_ENVELOPE_V1, "v1"],
    [TOKEN_ENVELOPE_V2, "v2"],
  ]
  for (const [prefix, version] of supported) {
    if (!value.startsWith(prefix)) continue
    const rest = value.slice(prefix.length)
    const separator = rest.indexOf(":")
    if (separator <= 0) return null
    return { version, keyId: rest.slice(0, separator), payload: rest.slice(separator + 1) }
  }
  return null
}

/**
 * Encrypts a plaintext token with the current key, produced as a v2 envelope
 * cryptographically bound to {@link context}. Missing or incomplete context
 * fails closed (no weakly-bound ciphertext is ever written), and
 * already-encrypted values are returned unchanged so re-runs never produce
 * double-encrypted tokens.
 */
export function encryptToken(
  plaintext: string,
  context: TokenContext,
  store: TokenKeyStore = getTokenKeyStore(),
): string {
  if (isEncryptedToken(plaintext)) return plaintext
  const ctx = requireContext(context, "encryptToken", "v2")

  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, store.current, iv)
  cipher.setAAD(aadFor(ctx))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()

  const payload = Buffer.concat([iv, authTag, ciphertext]).toString("base64")
  return `${TOKEN_ENVELOPE_V2}${store.currentKeyId}:${payload}`
}

function selectKeyForKeyId(keyId: string, store: TokenKeyStore): Buffer {
  if (keyId === store.currentKeyId) return store.current
  if (store.previous && keyId === store.previousKeyId) return store.previous
  throw new TokenDecryptionError(
    `Stored token was encrypted with a key that is no longer configured (key id ${keyId})`,
  )
}

/**
 * Decrypts a stored token. Legacy plaintext GitHub tokens are returned as-is.
 * v1 ciphertext is decrypted on the backwards-compatibility read path only and
 * does not need Account context (it was written without AAD). v2 ciphertext
 * requires the full owning Account {@link context} and fails closed when it is
 * missing. Corrupt, wrongly-keyed, or context-mismatched ciphertext raises
 * {@link TokenDecryptionError}; the error message never includes the token or
 * its ciphertext.
 */
export function decryptToken(
  encoded: string,
  context?: TokenContext,
  store?: TokenKeyStore,
): string {
  if (isPlaintextGitHubToken(encoded)) return encoded

  const parts = parseEncryptedToken(encoded)
  if (!parts) {
    throw new TokenDecryptionError(
      "Stored token is neither a recognized GitHub token nor a supported encrypted token",
    )
  }

  const ctx = parts.version === "v2" ? requireContext(context, "decryptToken", "v2") : undefined
  const resolved = store ?? getTokenKeyStore()

  const combined = Buffer.from(parts.payload, "base64")
  if (combined.length < IV_BYTES + TAG_BYTES) {
    throw new TokenDecryptionError("Malformed encrypted token: payload too short")
  }

  const key = selectKeyForKeyId(parts.keyId, resolved)

  const iv = combined.subarray(0, IV_BYTES)
  const authTag = combined.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = combined.subarray(IV_BYTES + TAG_BYTES)

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    if (ctx) decipher.setAAD(aadFor(ctx))
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString("utf8")
  } catch (cause) {
    throw new TokenDecryptionError(
      `Failed to decrypt stored token with key id ${parts.keyId} (wrong key, corrupted ciphertext, or account context mismatch)`,
      { cause },
    )
  }
}