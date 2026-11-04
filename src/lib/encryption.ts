import crypto from "node:crypto"

/**
 * Encrypted token envelope format:
 *
 *   enc:v1:<keyId>:<base64( iv || authTag || ciphertext )>
 *
 * - `v1` is the ciphertext format version.
 * - `<keyId>` is a short fingerprint of the exact AES-256 key that produced
 *   the ciphertext, so key rotation works without touching already-stored
 *   tokens and without guessing which key to try.
 * - `iv` is a fresh random 96-bit nonce (never reused).
 * - `authTag` is the 128-bit AES-GCM authentication tag.
 *
 * Plaintext GitHub tokens that were stored before encryption was enabled
 * (`gho_…`, `ghp_…`, `ghu_…`, `ghs_…`, `ghr_…`, `github_pat_…`) are still
 * returned as-is for backwards compatibility; anything that is neither a
 * known plaintext GitHub token nor a supported encrypted envelope is treated
 * as corrupt and fails loudly instead of being silently passed along.
 *
 * Key material:
 * - `TOKEN_ENCRYPTION_KEY`        – base64-encoded 32-byte key, used for
 *   encryption and decryption. Writes fail closed when it is missing.
 * - `TOKEN_ENCRYPTION_KEY_PREV`   – optional base64-encoded 32-byte *old* key
 *   that is accepted for decryption only, so a key rotation does not orphan
 *   already-encrypted tokens.
 */

export const TOKEN_CIPHER_PREFIX = "enc:v1:"

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16
const KEYID_ENCODED_CHARS = 6 // 4 bytes of key fingerprint → 6 base64url chars

const CURRENT_KEY_ENV = "TOKEN_ENCRYPTION_KEY"
const PREVIOUS_KEY_ENV = "TOKEN_ENCRYPTION_KEY_PREV"

const GITHUB_TOKEN_PATTERN = /^(gh[opurs]_|github_pat_)/i

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

/** Decodes and validates a base64-encoded 32-byte key from the environment. */
function decodeKey(raw: string, envName: string): Buffer {
  const key = Buffer.from(raw, "base64")
  if (key.length !== 32) {
    throw new Error(
      `${envName} must be a base64-encoded 256-bit key (decoded length must be 32 bytes, got ${key.length})`,
    )
  }
  return key
}

/** Short non-secret fingerprint of a key, used as the ciphertext key id. */
export function keyIdOf(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("base64url").slice(0, KEYID_ENCODED_CHARS)
}

/**
 * Resolves the configured keys. Throws when the primary key is missing so that
 * token *writes* fail closed (no plaintext is ever stored).
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

/** True when a stored value already uses the supported ciphertext envelope. */
export function isEncryptedToken(value: string): boolean {
  return value.startsWith(TOKEN_CIPHER_PREFIX)
}

/** True when a value is a legacy plaintext GitHub token stored before encryption. */
export function isPlaintextGitHubToken(value: string): boolean {
  return GITHUB_TOKEN_PATTERN.test(value)
}

/**
 * Encrypts a plaintext token with the current key. Missing key fails closed,
 * and already-encrypted values are returned unchanged so re-runs never produce
 * double-encrypted tokens.
 */
export function encryptToken(plaintext: string, store: TokenKeyStore = getTokenKeyStore()): string {
  if (isEncryptedToken(plaintext)) return plaintext

  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, store.current, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()

  const payload = Buffer.concat([iv, authTag, ciphertext]).toString("base64")
  return `${TOKEN_CIPHER_PREFIX}${store.currentKeyId}:${payload}`
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
 * Corrupt or wrongly-keyed ciphertext raises {@link TokenDecryptionError}; the
 * error message never includes the token or its ciphertext.
 *
 * The key store is resolved lazily, only when a value actually needs
 * decryption. This keeps legacy *plaintext* tokens readable even when
 * `TOKEN_ENCRYPTION_KEY` is not configured; encrypting/writing still fails
 * closed because {@link encryptToken} requires the key up front.
 */
export function decryptToken(encoded: string, store?: TokenKeyStore): string {
  if (isPlaintextGitHubToken(encoded)) return encoded
  const resolved = store ?? getTokenKeyStore()

  if (!isEncryptedToken(encoded)) {
    throw new TokenDecryptionError(
      "Stored token is neither a recognized GitHub token nor a supported encrypted token",
    )
  }

  const rest = encoded.slice(TOKEN_CIPHER_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator <= 0) {
    throw new TokenDecryptionError("Malformed encrypted token: missing key id")
  }
  const keyId = rest.slice(0, separator)
  const payload = rest.slice(separator + 1)

  const combined = Buffer.from(payload, "base64")
  if (combined.length < IV_BYTES + TAG_BYTES) {
    throw new TokenDecryptionError("Malformed encrypted token: payload too short")
  }

  const key = selectKeyForKeyId(keyId, resolved)

  const iv = combined.subarray(0, IV_BYTES)
  const authTag = combined.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = combined.subarray(IV_BYTES + TAG_BYTES)

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString("utf8")
  } catch (cause) {
    throw new TokenDecryptionError(
      `Failed to decrypt stored token with key id ${keyId} (wrong key or corrupted ciphertext)`,
      { cause },
    )
  }
}