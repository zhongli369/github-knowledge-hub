import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  withRetry,
  isRetryableLLMError,
  extractTokenUsage,
  llmRetryDelayMs,
  LLM_MAX_RETRIES,
} from "@/services/llm/llm-telemetry"

const savedRetryDelay = process.env.LLM_RETRY_BASE_DELAY_MS

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  if (savedRetryDelay === undefined) delete process.env.LLM_RETRY_BASE_DELAY_MS
  else process.env.LLM_RETRY_BASE_DELAY_MS = savedRetryDelay
})

describe("extractTokenUsage", () => {
  it("prefers total_tokens when the provider reports it", () => {
    expect(extractTokenUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })).toBe(30)
  })

  it("falls back to prompt + completion when total is absent", () => {
    expect(extractTokenUsage({ usage: { prompt_tokens: 10, completion_tokens: 20 } })).toBe(30)
  })

  it("returns null when the provider reports no usage", () => {
    expect(extractTokenUsage({})).toBeNull()
    expect(extractTokenUsage({ usage: null })).toBeNull()
    expect(extractTokenUsage(undefined)).toBeNull()
  })
})

describe("isRetryableLLMError", () => {
  it("treats rate limits, 5xx and timeouts as retryable", () => {
    expect(isRetryableLLMError(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(true)
    expect(isRetryableLLMError(Object.assign(new Error("boom"), { status: 503 }))).toBe(true)
    expect(isRetryableLLMError(Object.assign(new Error("boom"), { status: 500 }))).toBe(true)
    expect(isRetryableLLMError(new Error("request timed out after 10s"))).toBe(true)
    expect(isRetryableLLMError(new Error("fetch failed: ECONNRESET"))).toBe(true)
    expect(isRetryableLLMError(new Error("429 Too Many Requests"))).toBe(true)
  })

  it("never retries deterministic failures", () => {
    expect(isRetryableLLMError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false)
    expect(isRetryableLLMError(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe(false)
    expect(isRetryableLLMError(new Error("Incorrect API key provided"))).toBe(false)
    expect(isRetryableLLMError(new SyntaxError("Unexpected token"))).toBe(false)
    expect(isRetryableLLMError("a plain string")).toBe(false)
  })
})

describe("llmRetryDelayMs", () => {
  it("backs off exponentially with a cap", () => {
    process.env.LLM_RETRY_BASE_DELAY_MS = "500"
    expect(llmRetryDelayMs(0)).toBe(500)
    expect(llmRetryDelayMs(1)).toBe(1000)
    expect(llmRetryDelayMs(3)).toBe(4000)
    expect(llmRetryDelayMs(10)).toBe(4000)
  })

  it("allows tests to shrink the delay via env", () => {
    process.env.LLM_RETRY_BASE_DELAY_MS = "0"
    expect(llmRetryDelayMs(0)).toBe(0)
  })
})

describe("withRetry", () => {
  it("returns immediately on the first success", async () => {
    const fn = vi.fn(async () => "ok")
    await expect(withRetry(fn, { delayMs: () => 0 })).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries retryable failures and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce("recovered")

    await expect(withRetry(fn, { delayMs: () => 0 })).resolves.toBe("recovered")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("gives up after maxRetries and rethrows the last error", async () => {
    const boom = new Error("429 Too Many Requests")
    const fn = vi.fn().mockRejectedValue(boom)

    await expect(withRetry(fn, { maxRetries: 2, delayMs: () => 0 })).rejects.toBe(boom)
    expect(fn).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1)
  })

  it("does not retry non-retryable errors", async () => {
    const boom = new SyntaxError("Unexpected token")
    const fn = vi.fn().mockRejectedValue(boom)

    await expect(withRetry(fn, { delayMs: () => 0 })).rejects.toBe(boom)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("calls onRetry before each retry wait", async () => {
    const onRetry = vi.fn()
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockResolvedValueOnce("ok")

    await withRetry(fn, { delayMs: () => 0, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1)
  })

  it("is bounded to LLM_MAX_RETRIES by default", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("500 server error"))
    await expect(withRetry(fn, { delayMs: () => 0 })).rejects.toMatchObject({ message: "500 server error" })
    expect(fn).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1)
  })
})