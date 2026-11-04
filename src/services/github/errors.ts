/**
 * GitHub API error classification (P1 Agent B).
 *
 * The Octokit plugins (`@octokit/plugin-retry` + `@octokit/plugin-throttling` in
 * `@/lib/github/client`) already retry 429s, 5xxes and rate-limit windows. This
 * module classifies what SURVIVES those retries so callers can apply the
 * correct policy:
 *
 *   * 404   → the resource genuinely does not exist (repo, branch, file,
 *             README). Callers treat this as "absent", never as an outage.
 *   * 403 / 429 / 5xx / network errors → transient or auth/scope issues. These
 *             must NOT be reported as "not found" (which would let a task
 *             complete with a silently missing artifact); they are surfaced as
 *             exceptions so the caller can fail or retry the whole task.
 *
 * Anything that is not a 404 RequestError is thrown as a
 * `GitHubFetchError` carrying the original status (when known).
 */

interface RequestErrorLike {
  status?: number
  message?: string
  code?: string
}

function isRequestErrorLike(error: unknown): error is RequestErrorLike {
  return typeof error === "object" && error !== null
}

/** True when the error is a GitHub 404 (the "resource not found" signal). */
export function isNotFound(error: unknown): boolean {
  return (
    isRequestErrorLike(error) &&
    typeof (error as RequestErrorLike).status === "number" &&
    (error as RequestErrorLike).status === 404
  )
}

/** Extract a GitHub status code from an error, if the transport exposed one. */
export function statusOf(error: unknown): number | undefined {
  return isRequestErrorLike(error) ? (error as RequestErrorLike).status : undefined
}

/**
 * Render a stable, non-sensitive message for a GitHub fetch failure. Network /
 * transport errors (no `status`) are described as connection failures; HTTP
 * errors keep their status code. Never forwards request bodies or tokens.
 */
export function describeGitHubError(error: unknown): string {
  if (isRequestErrorLike(error)) {
    const like = error as RequestErrorLike
    if (typeof like.status === "number") {
      return `GitHub request failed with status ${like.status}${like.message ? `: ${like.message}` : ""}`
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return `GitHub request failed (network/transport): ${message}`
}

/** Wraps a non-404 GitHub failure so callers can distinguish it from other errors. */
export class GitHubFetchError extends Error {
  readonly status?: number
  constructor(error: unknown) {
    super(describeGitHubError(error))
    this.name = "GitHubFetchError"
    this.status = statusOf(error)
  }
}

/**
 * Normalize a GitHub error: 404 passes through untouched (callers need the raw
 * error to decide "not found"), anything else is wrapped in `GitHubFetchError`
 * so it visibly fails/retries instead of being treated as an absent resource.
 */
export function classifyGitHubError(error: unknown): never {
  if (isNotFound(error)) {
    throw error
  }
  throw error instanceof GitHubFetchError ? error : new GitHubFetchError(error)
}