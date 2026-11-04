import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Adapter, AdapterAccount } from "@auth/core/adapters"

// The real Prisma client must not be instantiated in unit tests; the wrapper
// under test only needs a stand-in for the singleton.
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import {
  TOKEN_CIPHER_PREFIX,
  TokenDecryptionError,
  decryptToken,
  encryptToken,
  isEncryptedToken,
  isPlaintextGitHubToken,
  keyIdOf,
} from "@/lib/encryption"
import { encryptAccountTokens, encryptingAdapter } from "@/lib/auth-adapter"

const PRIMARY_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
const PREVIOUS_KEY = Buffer.from("abcdef0123456789abcdef0123456789", "utf8")

const GITHUB_ACCESS_TOKEN = "gho_sample_github_access_token_1234567890"
const GITHUB_REFRESH_TOKEN = "ghr_sample_github_refresh_token_abcdef"

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

describe("token encryption", () => {
  it("produces a versioned ciphertext that decrypts back to the original", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN)
    expect(ciphertext.startsWith(TOKEN_CIPHER_PREFIX)).toBe(true)
    expect(ciphertext).not.toContain(GITHUB_ACCESS_TOKEN)
    expect(decryptToken(ciphertext)).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("uses a fresh random nonce so identical plaintext encrypts differently", () => {
    const a = encryptToken(GITHUB_ACCESS_TOKEN)
    const b = encryptToken(GITHUB_ACCESS_TOKEN)
    expect(a).not.toBe(b)
  })

  it("is idempotent: encrypted input is returned unchanged (no double encryption)", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN)
    expect(encryptToken(ciphertext)).toBe(ciphertext)
  })

  it("fails closed when TOKEN_ENCRYPTION_KEY is missing", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(() => encryptToken(GITHUB_ACCESS_TOKEN)).toThrow(/TOKEN_ENCRYPTION_KEY/)
  })

  it("rejects a non-base64 / non-32-byte key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "short"
    expect(() => encryptToken(GITHUB_ACCESS_TOKEN)).toThrow(/32 bytes/)
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

describe("missing key semantics (fail closed on write, lazy on read)", () => {
  it("reads legacy plaintext GitHub tokens without any key configured", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(decryptToken("ghp_plaintext_without_key_123")).toBe("ghp_plaintext_without_key_123")
    expect(decryptToken("github_pat_legacy_plain_789")).toBe("github_pat_legacy_plain_789")
  })

  it("cannot decrypt ciphertext when the key is missing", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN)
    delete process.env.TOKEN_ENCRYPTION_KEY
    expect(() => decryptToken(ciphertext)).toThrow(/TOKEN_ENCRYPTION_KEY/)
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

describe("decryption failures (explicit, no token leakage)", () => {
  it("raises a named error when decrypted with the wrong key", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN)
    process.env.TOKEN_ENCRYPTION_KEY = PREVIOUS_KEY.toString("base64")

    try {
      decryptToken(ciphertext)
      throw new Error("expected decryptToken to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(TokenDecryptionError)
      const message = (error as Error).message
      expect(message).not.toContain(GITHUB_ACCESS_TOKEN)
      expect(message).not.toContain(ciphertext.slice(TOKEN_CIPHER_PREFIX.length))
    }
  })

  it("raises a named error on corrupted ciphertext", () => {
    const ciphertext = encryptToken(GITHUB_ACCESS_TOKEN)
    const corrupted = `${ciphertext.slice(0, -3)}AAA`
    expect(() => decryptToken(corrupted)).toThrow(TokenDecryptionError)
  })

  it("raises a named error on malformed encrypted envelopes", () => {
    expect(() => decryptToken(`${TOKEN_CIPHER_PREFIX}tooshort`)).toThrow(TokenDecryptionError)
    const wrongLength = `${TOKEN_CIPHER_PREFIX}k12345:${Buffer.from("abcdefgh").toString("base64")}`
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
    const oldCiphertext = encryptToken(GITHUB_ACCESS_TOKEN)

    // Rotate: new primary key, old key moved to the PREV slot.
    process.env.TOKEN_ENCRYPTION_KEY = PRIMARY_KEY.toString("base64")
    process.env.TOKEN_ENCRYPTION_KEY_PREV = PREVIOUS_KEY.toString("base64")

    expect(decryptToken(oldCiphertext)).toBe(GITHUB_ACCESS_TOKEN)

    // New writes use the new key.
    const newCiphertext = encryptToken(GITHUB_REFRESH_TOKEN)
    expect(newCiphertext).not.toBe(oldCiphertext)
    expect(decryptToken(newCiphertext)).toBe(GITHUB_REFRESH_TOKEN)
  })

  it("rejects old-key ciphertext once the previous key is removed", () => {
    process.env.TOKEN_ENCRYPTION_KEY = PREVIOUS_KEY.toString("base64")
    const oldCiphertext = encryptToken(GITHUB_ACCESS_TOKEN)

    process.env.TOKEN_ENCRYPTION_KEY = PRIMARY_KEY.toString("base64")
    delete process.env.TOKEN_ENCRYPTION_KEY_PREV

    expect(() => decryptToken(oldCiphertext)).toThrow(/no longer configured/)
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

    expect(decryptToken(stored.access_token!)).toBe(GITHUB_ACCESS_TOKEN)
    expect(decryptToken(stored.refresh_token!)).toBe(GITHUB_REFRESH_TOKEN)
  })

  it("leaves missing or already-encrypted fields untouched (no double encryption)", async () => {
    const cipher = encryptToken(GITHUB_ACCESS_TOKEN)
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
    expect(decryptToken(encrypted.access_token!)).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("decrypts tokens read back through getAccount", async () => {
    const cipher = encryptToken(GITHUB_ACCESS_TOKEN)
    const base = {
      getAccount: vi.fn(async () =>
        githubAccount({ providerAccountId: "42", access_token: cipher }),
      ),
    } as unknown as Adapter
    const adapter = encryptingAdapter(base)

    const account = await adapter.getAccount!("42", "github")
    expect(account?.access_token).toBe(GITHUB_ACCESS_TOKEN)
  })

  it("passes through null from getAccount", async () => {
    const base = { getAccount: vi.fn(async () => null) } as unknown as Adapter
    const adapter = encryptingAdapter(base)
    expect(await adapter.getAccount!("nope", "github")).toBeNull()
  })
})