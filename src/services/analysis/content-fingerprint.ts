/**
 * Content fingerprinting for the AI auto-increment analysis pipeline (P3).
 *
 * Two distinct hashes exist:
 *
 *   * `createAnalysisContentHash` fingerprints the *repo-summary input* — the
 *     stable repository metadata plus the README. The worker writes this hash on
 *     every `repo_summary` Analysis row it runs, and reuses a previously
 *     completed summary when another completed row carries the exact same hash
 *     (content was not actually re-authored, so the LLM call is skipped).
 *   * `createFileContentHash` fingerprints a single file's raw content for the
 *     per-asset extraction dedup.
 *
 * Both are pure, synchronous, SHA256-based functions with no I/O and no
 * secrets, so they are trivially unit-testable.
 */

import { createHash } from "node:crypto"

/**
 * Metadata keys that change frequently without any semantic change to a
 * repository summary (stars/forks/watchers and their snake_case GitHub API
 * spellings). They are stripped before hashing so a star bump on GitHub does
 * not invalidate an existing summary.
 */
const VOLATILE_METADATA_KEYS: ReadonlySet<string> = new Set<string>([
  "stars",
  "stargazers_count",
  "forks",
  "forks_count",
  "watchers",
  "watchers_count",
  "size",
  "open_issues",
  "open_issues_count",
  "pushed_at",
  "pushedAt",
  "updated_at",
  "updatedAt",
  "lastFetchedAt",
])

/**
 * Deterministic JSON-ish serialization.
 *
 * Rules:
 *   - object keys are emitted in bytewise sorted order;
 *   - array order is preserved (an ordered array is part of the identity);
 *   - `undefined` object members are omitted, `undefined` array members become
 *     `null`;
 *   - non-finite numbers and `-0` are normalized (`-0` → `0`).
 *
 * The same logical input always produces the same string.
 */
export function stableStringify(value: unknown): string {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value)
    case "number":
      if (Number.isNaN(value)) return "null"
      return Object.is(value, -0) ? "0" : JSON.stringify(value)
    case "undefined":
      return "null"
    case "object": {
      if (value === null) return "null"
      if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(",")}}`
    }
    default:
      // bigint, function, symbol — serialized by their String() form.
      return JSON.stringify(String(value))
  }
}

export interface AnalysisContentInput {
  /** Stable repository metadata (name, fullName, description, topics, ...). */
  metadata: Record<string, unknown>
  /** Raw README content, or null when the repository has no README. */
  readme: string | null
}

/**
 * Deterministic SHA256 fingerprint of a repo-summary task's inputs.
 *
 * This is the cache key used by `queueChangedRepositoryAnalysis` /
 * `analysis-worker.ts` to reuse a previous `repo_summary` result when nothing
 * that affects the generated summary actually changed.
 *
 * Frequently-changing counts (`stars`, `forks`, `watchers`, `size`, ...) are
 * excluded so a popularity bump never re-runs the paid LLM summary.
 */
export function createAnalysisContentHash(input: AnalysisContentInput): string {
  const { metadata, readme } = input
  const stableMetadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!VOLATILE_METADATA_KEYS.has(key)) stableMetadata[key] = value
  }

  const canonical = stableStringify({
    metadata: stableMetadata,
    readme: typeof readme === "string" ? readme : null,
  })

  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/**
 * Deterministic SHA256 of a single file's source content. Used by the
 * extraction pipeline to detect that a file's content did not change between
 * syncs, so the LLM is not called again for identical bytes.
 */
export function createFileContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}