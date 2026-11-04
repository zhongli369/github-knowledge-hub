/**
 * Reusable AI analysis telemetry + retry primitives.
 *
 * Both the synchronous Server Action path (`analyzeRepoSummary` direct path)
 * and the background worker path share these helpers so that cost
 * (`tokensUsed`) and latency (`durationMs`) are measured and classified the
 * same way for a single task, a batch item, or a queued task.
 */

export interface AnalysisMetrics {
  durationMs: number
  tokensUsed: number | null
}

/** How many times a *transient* LLM failure is retried (beyond the first attempt). */
export const LLM_MAX_RETRIES = 2

const DEFAULT_RETRY_BASE_DELAY_MS = 500

function readRetryBaseDelayMs(): number {
  const raw = process.env.LLM_RETRY_BASE_DELAY_MS
  if (!raw) return DEFAULT_RETRY_BASE_DELAY_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETRY_BASE_DELAY_MS
}

/** Exponential backoff with a cap: 500ms → 1s → 2s → 4s (base configurable via env for tests). */
export function llmRetryDelayMs(attempt: number): number {
  const base = readRetryBaseDelayMs()
  return Math.min(base * 2 ** Math.max(0, attempt), 4000)
}

export interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface OpenAICompletionResponseLike {
  usage?: OpenAIUsage | null
}

/**
 * Pull real token usage from a provider response.
 *
 * Returns `null` when the provider did not report usage so the caller can
 * persist an explicit empty (the `Analysis.tokensUsed` column is a non-null
 * int defaulting to 0) instead of fabricating a number.
 */
export function extractTokenUsage(response: OpenAICompletionResponseLike | unknown): number | null {
  const usage = (response as { usage?: OpenAIUsage | null } | null)?.usage
  if (!usage) return null
  if (typeof usage.total_tokens === "number") return usage.total_tokens
  const prompt = usage.prompt_tokens
  const completion = usage.completion_tokens
  if (typeof prompt === "number" && typeof completion === "number") return prompt + completion
  return null
}

/**
 * Classify an LLM failure as retryable: rate limits (429), timeouts, 5xx and
 * transport-level failures. Deterministic failures (invalid key, bad request,
 * JSON parse) must NOT be retried.
 */
export function isRetryableLLMError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const status = (error as unknown as { status?: unknown }).status
  if (typeof status === "number") {
    return status === 408 || status === 429 || (status >= 500 && status <= 599)
  }

  const msg = error.message ?? ""
  return /rate.?limit|too many requests|5\d\d|\b429\b|\b408\b|timeout|timed\s?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|connection error|temporar(ily|y).*(error|failure|unavailable)|service unavailable|\b503\b/i.test(
    msg
  )
}

export interface RetryOptions {
  maxRetries?: number
  isRetryable?: (error: unknown) => boolean
  delayMs?: (attempt: number) => number
  /** Called before a retry wait; useful for logging. */
  onRetry?: (error: unknown, attempt: number) => void
}

/** Run `fn`, retrying only retryable failures with bounded attempts + backoff. */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetries = options?.maxRetries ?? LLM_MAX_RETRIES
  const isRetryable = options?.isRetryable ?? isRetryableLLMError
  const delayMs = options?.delayMs ?? llmRetryDelayMs

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt >= maxRetries || !isRetryable(error)) throw error
      options?.onRetry?.(error, attempt + 1)
      await sleep(delayMs(attempt))
    }
  }
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}