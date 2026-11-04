import crypto from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Adapter, AdapterAccount } from "@auth/core/adapters"

// The real Prisma client must not be instantiated in unit tests; the wrapper
// under test only needs a stand-in for the singleton.
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import {
  TOKEN_ENVELOPE_V1,
  TOKEN_ENVELOPE_V2,
  TokenDecryptionError,
  aadFor,
  decryptToken,
  encryptToken,
  getTokenKeyStore,
  isEncryptedToken,
  isPlaintextGitHubToken,
  keyIdOf,
  parseEncryptedToken,
  type TokenContext,
} from "@/lib/encryption"
import { encryptAccountTokens, encryptingAdapter } from "@/lib/auth-adapter"

const PRIMARY_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
const PREVIOUS_KEY = Buffer.from("abcdef0123456789abcdef0123456789", "utf8")

const GITHUB_ACCESS_TOKEN = "gho_sample_github_access_token_1234567890"
const GITHUB_REFRESH_TOKEN = "ghr_sample_github_refresh_token_abcdef"

const CONTEXT: TokenContext = {
  provider: "github",
  providerAccountId: "12345",
  userId: "user-1",
  field: "access_token",
}
const OTHER_ACCOUNT_CONTEXT: TokenContext = {
  ...CONTEXT,
  providerAccountId: "99999",
  userId: "user-2",
}
const REFRESH_FIELD_CONTEXT: TokenContext = { ...CONTEXT, field: "refresh_token" }

/**
 * Produces a genuine legacy v1 envelope (no AAD) with the current key. v1 is
 * the pre-AAD format, so the payload must be GCM-encrypted WITHOUT AAD.
 */
function encryptV1Legacy(plaintext: string, key: Buffer = PRIMARY_KEY): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, authTag, ciphertext]).toString("base64")
  return `${TOKEN_ENVELOPE_V1}${keyIdOf(key)}:${payload}`
}

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    TOKEN_ENCRYPTION_KEY_PREV: process.env.TOKEN_ENCRYPTION_KEY_PREV,
  }
  process.env.TOKEN_ENCRYPTION_KEY = PRIMARY_KEY.toString("base64")
  delete process.env.TOKEN_ENCRYPTION_KEY_PREV
})

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe("token encryption (v2)", () => {
  it("produces a versioned v2 ciphertext that decrypts back to the original", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(ciphertext.startsWith(TOKEN_ENVELOPE_V2)).toBe(true)
    expect(ciphertext).not.toContain(GITHUB_ACCESS_TOKEN)
    expect(decryptToken(ciphertext, CONTEXT)).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("never produces legacy v1 envelopes", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(ciphertext.startsWith(TOKEN_ENVELOPE_V1)).toBe(false)
    const parts = parseEncryptedToken(ciphertext)
    expect(parts?.version).toBe("v2")
  })

  it("uses a fresh random nonce so identical plaintext encrypts differently", () => {
    const a = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    const b = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(a).not.toBe(b)
  })

  it("is idempotent: encrypted input is returned unchanged (no double encryption)", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(encryptToken(ciphertext, CONTEXT)).toBe(ciphertext)
  })

  it("binds v2 ciphertext to the Account context via AAD", () => {
    const aad = aadFor(CONTEXT).toString("utf8")
    expect(aad).toContain("account-token-v2")
    expect(aad).toContain(CONTEXT.provider)
    expect(aad).toContain(CONTEXT.providerAccountId)
    expect(aad).toContain(CONTEXT.userId)
    expect(aad).toContain(CONTEXT.field)
  })

  it("fails closed when TOKEN_ENCRYPTION_KEY is missing", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(() => encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)).toThrow(/TOKEN_ENCRYPTION_KEY/)
  })

  it("rejects a non-base64 / non-32-byte key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "short"
    expect(() => encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)).toThrow(/32 bytes/)
  })
})

describe("v2 Account-context AAD binding (anti-transplantation)", () => {
  it("refuses to decrypt a token with a different Account context", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(() => decryptToken(ciphertext, OTHER_ACCOUNT_CONTEXT)).toThrow(TokenDecryptionError)
    expect(decryptToken(ciphertext, CONTEXT)).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("refuses to decrypt a token with a different user id", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(() => decryptToken(ciphertext, { ...CONTEXT, userId: "other-user" })).toThrow(
      TokenDecryptionError,
    )
  })

  it("refuses to swap an access token into the refresh_token field", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(() => decryptToken(ciphertext, REFRESH_FIELD_CONTEXT)).toThrow(TokenDecryptionError)
  })

  it("refuses to decrypt a refresh token as an access token", () => {
    const ciphertext = encryptToken(GITHUB_REFRESH_TOKEN, REFRESH_FIELD_CONTEXT)
    expect(() => decryptToken(ciphertext, { ...REFRESH_FIELD_CONTEXT, field: "access_token" })).toThrow(
      TokenDecryptionError,
    )
    expect(decryptToken(ciphertext, REFRESH_FIELD_CONTEXT)).toBe(GITHUB_REFRESH_TOKEN)
  })

  it("a stored ciphertext transplanted to a different account cannot be read there", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(() => decryptToken(ciphertext, OTHER_ACCOUNT_CONTEXT)).toThrow(TokenDecryptionError)
  })
})

describe("v2 context enforcement (fail closed)", () => {
  it("refuses to encrypt without an account context", () => {
    expect(() => encryptToken(GITHUB_ACCESS_TOKEN, undefined as unknown as TokenContext)).toThrow(
      /requires Account context/,
    )
  })

  it("refuses to encrypt with an incomplete account context", () => {
    expect(() =>
      encryptToken(GITHUB_ACCESS_TOKEN, { ...CONTEXT, userId: "" } as TokenContext),
    ).toThrow(/non-empty Account context field "userId"/)
  })

  it("refuses to decrypt v2 ciphertext without context", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(() => decryptToken(ciphertext)).toThrow(/requires Account context/)
  })

  it("refuses to decrypt v2 ciphertext with an empty-account context", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    expect(() =>
      decryptToken(ciphertext, { provider: "", providerAccountId: "", userId: "", field: "access_token" }),
    ).toThrow(/non-empty Account context field "provider"/)
  })
})

describe("legacy plaintext compat", () => {
  it("returns plaintext classic and fine-grained GitHub tokens as-is", () => {
    const classic = "ghp_legacy_plaintext_pat_123"
    expect(decryptToken(classic)).toBe(classic)
    expect(isPlaintextGitHubToken(classic)).toBe(true)

    const fineGrained = "github_pat_legacy_fine_grained_456"
    expect(decryptToken(fineGrained)).toBe(fineGrained)
    expect(isPlaintextGitHubToken(fineGrained)).toBe(true)

    for (const prefix of ["gho_", "ghp_", "ghu_", "ghs_", "ghr_"]) {
      expect(isPlaintextGitHubToken(`${prefix}token`)).toBe(true)
    }
  })

  it("fails loudly on values that are neither a known token nor ciphertext", () => {
    expect(() => decryptToken("not-a-token")).toThrow(TokenDecryptionError)
    expect(() => decryptToken("")).toThrow(TokenDecryptionError)
  })
})

describe("v1 ciphertext compat read path", () => {
  it("decrypts a legacy v1 envelope on the read path (no AAD required)", () => {
    const v1 = encryptV1Legacy(GITHUB_ACCESS_TOKEN)
    expect(isEncryptedToken(v1)).toBe(true)
    expect(parseEncryptedToken(v1)).toEqual({
      version: "v1",
      keyId: keyIdOf(PRIMARY_KEY),
      payload: expect.any(String),
    })
    // v1 is readable with or without context: it carries no AAD.
    expect(decryptToken(v1)).toBe(GITHUB_ACCESS_TOKEN)
    expect(decryptToken(v1, CONTEXT)).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("v1 envelopes are still recognized as encrypted (never double-encrypted)", () => {
    const v1 = encryptV1Legacy(GITHUB_ACCESS_TOKEN)
    expect(encryptToken(v1, CONTEXT)).toBe(v1)
  })

  it("v1 ciphertext is not protected by context (no AAD) — v2 is required for that", () => {
    const v1 = encryptV1Legacy(GITHUB_ACCESS_TOKEN)
    // A different account context must NOT change v1 decryption (v1 has no AAD
    // to check), which is exactly why the migration upgrades v1 → v2.
    expect(decryptToken(v1, OTHER_ACCOUNT_CONTEXT)).toBe(GITHUB_ACCESS_TOKEN)
  })
})

describe("missing key semantics (fail closed on write, lazy on read)", () => {
  it("reads legacy plaintext GitHub tokens without any key configured", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(decryptToken("ghp_plaintext_without_key_123")).toBe("ghp_plaintext_without_key_123")
    expect(decryptToken("github_pat_legacy_plain_789")).toBe("github_pat_legacy_plain_789")
  })

  it("cannot decrypt v2 ciphertext when the key is missing (context supplied)", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(() => decryptToken(ciphertext, CONTEXT)).toThrow(/TOKEN_ENCRYPTION_KEY/)
  })

  it("new writes still fail closed without a key (adapter rejects, nothing stored)", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    const linkAccount = vi.fn(async () => undefined)
    const adapter = encryptingAdapter({ linkAccount } as unknown as Adapter)

    await expect(
      adapter.linkAccount!({
        userId: "user-1",
        type: "oauth",
        provider: "github",
        providerAccountId: "12345",
        access_token: GITHUB_ACCESS_TOKEN,
      }),
    ).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/)
    expect(linkAccount).not.toHaveBeenCalled()
  })
})

describe("insecure key rejection", () => {
  it("rejects an all-zero key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64")
    expect(() => getTokenKeyStore()).toThrow(/all-zero key/)
    expect(() => encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)).toThrow(/all-zero key/)
  })

  it("rejects a constant-byte (repeated) key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 0x41).toString("base64")
    expect(() => getTokenKeyStore()).toThrow(/constant-byte key/)
    expect(() => decryptToken(encryptV1Legacy(GITHUB_ACCESS_TOKEN))).toThrow(/constant-byte key/)
  })

  it("rejects an all-zero previous key as well", () => {
    process.env.TOKEN_ENCRYPTION_KEY = PRIMARY_KEY.toString("base64")
    process.env.TOKEN_ENCRYPTION_KEY_PREV = Buffer.alloc(32).toString("base64")
    expect(() => getTokenKeyStore()).toThrow(/all-zero key/)
  })
})

describe("decryption failures (explicit, no token leakage)", () => {
  it("raises a named error when decrypted with the wrong key", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    process.env.TOKEN_ENCRYPTION_KEY = PREVIOUS_KEY.toString("base64")

    try {
      decryptToken(ciphertext, CONTEXT)
      throw new Error("expected decryptToken to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(TokenDecryptionError)
      const message = (error as Error).message
      expect(message).not.toContain(GITHUB_ACCESS_TOKEN)
      expect(message).not.toContain(ciphertext.slice(TOKEN_ENVELOPE_V2.length))
    }
  })

  it("raises a named error on corrupted ciphertext", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    const corrupted = `${ciphertext.slice(0, -3)}AAA`
    expect(() => decryptToken(corrupted, CONTEXT)).toThrow(TokenDecryptionError)
  })

  it("raises a named error on malformed encrypted envelopes", () => {
    expect(() => decryptToken(`${TOKEN_ENVELOPE_V1}tooshort`)).toThrow(TokenDecryptionError)
    const wrongLength = `${TOKEN_ENVELOPE_V1}k12345:${Buffer.from("abcdefgh").toString("base64")}`
    expect(() => decryptToken(wrongLength)).toThrow(/payload too short/)
  })
})

describe("key ids and key rotation", () => {
  it("gives different keys different ids", () => {
    expect(keyIdOf(PRIMARY_KEY)).not.toBe(keyIdOf(PREVIOUS_KEY))
  })

  it("decrypts tokens previously encrypted with the rotated previous key", () => {
    // Encrypt with the "old" key while it is still the primary one.
    process.env.TOKEN_ENCRYPTION_KEY = PREVIOUS_KEY.toString("base64")
    const oldCiphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)

    // Rotate: new primary key, old key moved to the PREV slot.
    process.env.TOKEN_ENCRYPTION_KEY = PRIMARY_KEY.toString("base64")
    process.env.TOKEN_ENCRYPTION_KEY_PREV = PREVIOUS_KEY.toString("base64")

    expect(decryptToken(oldCiphertext, CONTEXT)).toBe(GITHUB_ACCESS_TOKEN)

    // New writes use the new key.
    const newCiphertext = encryptToken(GITHUB_REFRESH_TOKEN, CONTEXT)
    expect(newCiphertext).not.toBe(oldCiphertext)
    expect(decryptToken(newCiphertext, CONTEXT)).toBe(GITHUB_REFRESH_TOKEN)
  })

  it("rejects old-key ciphertext once the previous key is removed", () => {
    process.env.TOKEN_ENCRYPTION_KEY = PREVIOUS_KEY.toString("base64")
    const oldCiphertext = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)

    process.env.TOKEN_ENCRYPTION_KEY = PRIMARY_KEY.toString("base64")
    delete process.env.TOKEN_ENCRYPTION_KEY_PREV

    expect(() => decryptToken(oldCiphertext, CONTEXT)).toThrow(/no longer configured/)
  })
})

describe("adapter write path interception", () => {
  function baseAdapterSpy() {
    const written: AdapterAccount[] = []
    const linkAccount = vi.fn(async (account: AdapterAccount) => {
      written.push(account)
      return account
    })
    return { written, linkAccount, base: { linkAccount } as unknown as Adapter }
  }

  function githubAccount(overrides: Partial<AdapterAccount> = {}): AdapterAccount {
    return {
      userId: "user-1",
      type: "oauth",
      provider: "github",
      providerAccountId: "12345",
      ...overrides,
    }
  }

  it("writes ciphertext, not plaintext, through the real linkAccount path", async () => {
    const { base, written, linkAccount } = baseAdapterSpy()
    const adapter = encryptingAdapter(base)

    await adapter.linkAccount!(
      githubAccount({ access_token: GITHUB_ACCESS_TOKEN, refresh_token: GITHUB_REFRESH_TOKEN }),
    )

    expect(linkAccount).toHaveBeenCalledTimes(1)
    expect(written).toHaveLength(1)
    const stored = written[0]

    expect(stored.access_token).not.toBe(GITHUB_ACCESS_TOKEN)
    expect(isEncryptedToken(stored.access_token!)).toBe(true)
    expect(stored.refresh_token).not.toBe(GITHUB_REFRESH_TOKEN)
    expect(isEncryptedToken(stored.refresh_token!)).toBe(true)

    expect(decryptToken(stored.access_token!, CONTEXT)).toBe(GITHUB_ACCESS_TOKEN)
    expect(decryptToken(stored.refresh_token!, REFRESH_FIELD_CONTEXT)).toBe(GITHUB_REFRESH_TOKEN)
  })

  it("leaves missing or already-encrypted fields untouched (no double encryption)", async () => {
    const cipher = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    const { base, written, linkAccount } = baseAdapterSpy()
    const adapter = encryptingAdapter(base)

    await adapter.linkAccount!(githubAccount({ access_token: cipher }))

    expect(linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: cipher }),
    )
    expect(written[0].refresh_token).toBeUndefined()
  })

  it("fails closed (rejects) without TOKEN_ENCRYPTION_KEY and never writes", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    const { base, linkAccount } = baseAdapterSpy()
    const adapter = encryptingAdapter(base)

    await expect(
      adapter.linkAccount!(githubAccount({ access_token: GITHUB_ACCESS_TOKEN })),
    ).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/)
    expect(linkAccount).not.toHaveBeenCalled()
  })

  it("encryptAccountTokens is safe on standalone use", async () => {
    const encrypted = await encryptAccountTokens(
      githubAccount({ access_token: GITHUB_ACCESS_TOKEN }),
    )
    expect(decryptToken(encrypted.access_token!, CONTEXT)).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("decrypts tokens read back through getAccount", async () => {
    const cipher = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    const base = {
      getAccount: vi.fn(async () =>
        githubAccount({ providerAccountId: CONTEXT.providerAccountId, access_token: cipher }),
      ),
    } as unknown as Adapter
    const adapter = encryptingAdapter(base)

    const account = await adapter.getAccount!(CONTEXT.providerAccountId, "github")
    expect(account?.access_token).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("fails closed when a v2 read is decrypted with the wrong account context", async () => {
    const cipher = encryptToken(GITHUB_ACCESS_TOKEN, CONTEXT)
    const base = {
      // Row came from a different Account than the one decryptToken is asked to use.
      getAccount: vi.fn(async () =>
        githubAccount({
          providerAccountId: "other-account",
          userId: "user-2",
          access_token: cipher,
        }),
      ),
    } as unknown as Adapter
    const adapter = encryptingAdapter(base)

    await expect(adapter.getAccount!("x", "github")).rejects.toThrow(TokenDecryptionError)
  })

  it("passes through null from getAccount", async () => {
    const base = { getAccount: vi.fn(async () => null) } as unknown as Adapter
    const adapter = encryptingAdapter(base)
    expect(await adapter.getAccount!("nope", "github")).toBeNull()
  })
})