import crypto from "crypto"

const ALGORITHM = "aes-256-gcm"
const SALT = "github-knowledge-hub-salt"

function deriveKeySync(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, SALT, 100_000, 32, "sha256")
}

export async function encryptToken(plaintext: string): Promise<string> {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is required for token encryption")

  const key = deriveKeySync(secret)
  const iv = crypto.randomBytes(12)

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()

  const combined = Buffer.concat([iv, tag, ciphertext])
  return combined.toString("base64")
}

function isGithubToken(token: string): boolean {
  return /^gh[opurs]_/i.test(token)
}

export async function decryptToken(encoded: string): Promise<string> {
  // Tokens may be stored as plaintext (not yet encrypted). Return them as-is.
  if (isGithubToken(encoded)) return encoded

  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is required for token decryption")

  const key = deriveKeySync(secret)
  const combined = Buffer.from(encoded, "base64")

  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const ciphertext = combined.subarray(28)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return plaintext.toString("utf8")
}
