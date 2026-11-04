"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isEmbeddingUnavailableError } from "@/lib/embeddings"
import {
  searchReposByText,
  searchReposPage,
  getSimilarRepos,
  type SearchResult,
  type SearchFilters,
  type SearchMode,
  type RepoSortKey,
  type RepoSearchPageResult,
} from "@/services/llm/repo-embedding.service"

export type SearchErrorCode = "NOT_AUTHENTICATED" | "EMBEDDING_UNAVAILABLE" | "SEARCH_FAILED"

export interface SearchActionResult {
  ok: boolean
  data: RepoSearchPageResult | null
  error: string | null
  errorCode: SearchErrorCode | null
}

export interface RepoSearchPageParams {
  page?: number
  pageSize?: number
  sort?: RepoSortKey
  filters?: SearchFilters
}

export async function searchReposAction(
  query: string,
  filters?: SearchFilters,
  searchMode?: SearchMode
): Promise<SearchResult[]> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return searchReposByText(query, session.user.id, 20, filters, searchMode)
}

export async function searchReposPageAction(
  query: string,
  searchMode: SearchMode = "hybrid",
  params: RepoSearchPageParams = {}
): Promise<SearchActionResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { ok: false, data: null, error: "Not authenticated", errorCode: "NOT_AUTHENTICATED" }
  }

  try {
    const data = await searchReposPage(query, session.user.id, params, searchMode)
    return { ok: true, data, error: null, errorCode: null }
  } catch (error) {
    const errorCode: SearchErrorCode = isEmbeddingUnavailableError(error)
      ? "EMBEDDING_UNAVAILABLE"
      : "SEARCH_FAILED"
    return { ok: false, data: null, error: "Search failed", errorCode }
  }
}

export async function getFilterOptions(): Promise<{ languages: string[] }> {
  const session = await auth()
  if (!session?.user?.id) return { languages: [] }

  const repos = await prisma.repository.findMany({
    where: { userId: session.user.id, language: { not: null } },
    select: { language: true },
    distinct: ["language"],
  })

  const languages = repos
    .map((r) => r.language!)
    .filter(Boolean)
    .sort()

  return { languages }
}

export async function getSimilarReposAction(
  repoId: string
): Promise<SearchResult[]> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return getSimilarRepos(repoId, session.user.id, 5)
}
