"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import {
  searchReposByText,
  getSimilarRepos,
  type SearchResult,
  type SearchFilters,
  type SearchMode,
} from "@/services/llm/repo-embedding.service"

export async function searchReposAction(
  query: string,
  filters?: SearchFilters,
  searchMode?: SearchMode
): Promise<SearchResult[]> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return searchReposByText(query, session.user.id, 20, filters, searchMode)
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
