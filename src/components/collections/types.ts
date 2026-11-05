// ── Contract-derived types ───────────────────────────────────────
// These are derived from the actions implemented in parallel by Agent B
// (`src/actions/collections`) and Agent D (`src/actions/classification`).
// Deriving keeps this frontend in sync with the real return types without
// duplicating shapes by hand.

import { listCategoryCollections, listCategoryRepositories } from "@/actions/collections"

export type CategoryCollectionSummary = Awaited<
  ReturnType<typeof listCategoryCollections>
>[number]

export type CategoryReposResponse = Awaited<ReturnType<typeof listCategoryRepositories>>

export type CategoryRepoItem = CategoryReposResponse["items"][number]

export type CategoryInfo = CategoryReposResponse["category"]

export type CategorySort = "stars" | "updated" | "name"

// Progress shape returned by Agent D's getClassificationProgress.
export type ClassificationProgress = {
  total: number
  pending: number
  running: number
  completed: number
  failed: number
  succeeded: number
  skipped: number
}