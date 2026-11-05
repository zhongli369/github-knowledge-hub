import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import {
  normalizeCategoryRepositoryQuery,
  normalizeMembershipArgs,
} from "./validation"

// ── Public shapes (server-action contract) ─────────────────────────

export type CategoryCollectionSummary = {
  id: string
  slug: string
  name: string
  description: string | null
  repositoryCount: number
}

export type CategoryRepositoryQuery = {
  slug: string
  search?: string
  language?: string
  sort?: "stars" | "updated" | "name"
  page?: number
  pageSize?: number
}

export type CategoryRepositoryItem = {
  id: string
  name: string
  fullName: string
  description: string | null
  url: string
  language: string | null
  stars: number
  topics: string[]
  note: string | null
  status: string
  summary: string | null
  updatedAt: string
  classifierSource: "auto" | "manual"
  keywords: string[]
}

export type CategoryRepositoriesResult = {
  category: CategoryCollectionSummary
  items: CategoryRepositoryItem[]
  total: number
  page: number
  pageSize: number
  languages: string[]
}

/**
 * Loose input form for the lib: the server-action contract uses strict
 * `sort`, but the lib also accepts unknown sort values and falls back to the
 * default after validation.
 */
type CategoryRepositoryQueryInput = Omit<CategoryRepositoryQuery, "sort"> & {
  sort?: string
}

// ── List category collections with included-repo counts ───────────

/**
 * All `kind="category"` collections owned by `userId`, ordered by name.
 * `repositoryCount` only counts non-excluded memberships, so a manually
 * excluded repository never shows up in a category summary.
 */
export async function listCategoryCollectionsForUser(
  userId: string
): Promise<CategoryCollectionSummary[]> {
  const collections = await prisma.collection.findMany({
    where: { userId, kind: "category" },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      _count: {
        select: {
          repositories: { where: { excluded: false } },
        },
      },
    },
    orderBy: { name: "asc" },
  })

  return collections.map((c) => ({
    id: c.id,
    // slug is the identity the client should use; legacy rows without a slug
    // fall back to the id so they remain addressable.
    slug: c.slug ?? c.id,
    name: c.name,
    description: c.description,
    repositoryCount: c._count.repositories,
  }))
}

// ── List repositories inside one category ─────────────────────────

type IncludedLinkShape = { source: string; excluded: boolean }

/**
 * All `excluded=false` memberships of `collectionId` for `userId`.
 * Used as the `Repository.collectionLinks.some` relation filter so the query
 * is both user-scoped and (by construction) never leaks excluded rows.
 */
function includedMembershipFilter(collectionId: string) {
  return {
    collectionId,
    excluded: false,
  }
}

function buildOrderBy(
  sort: "stars" | "updated" | "name"
): Prisma.RepositoryOrderByWithRelationInput[] {
  switch (sort) {
    case "stars":
      return [{ stars: Prisma.SortOrder.desc }, { fullName: Prisma.SortOrder.asc }]
    case "name":
      return [{ fullName: Prisma.SortOrder.asc }]
    case "updated":
    default:
      return [
        { pushedAt: { sort: Prisma.SortOrder.desc, nulls: Prisma.NullsOrder.last } },
        { lastFetchedAt: Prisma.SortOrder.desc },
        { fullName: Prisma.SortOrder.asc },
      ]
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

function extractSummaryText(
  analysis: { status: string; result: unknown } | undefined
): { oneLine: string | null; summary: AnyRecord | null } {
  if (!analysis || analysis.status !== "completed") return { oneLine: null, summary: null }
  const result = (analysis.result ?? null) as AnyRecord | null
  const summary = (result?.summary ?? null) as AnyRecord | null
  if (!summary) return { oneLine: null, summary: null }
  const oneLine = typeof summary.oneLine === "string" && summary.oneLine ? summary.oneLine : null
  return { oneLine, summary }
}

function buildKeywords(topics: string[], summary: AnyRecord | null): string[] {
  const keywords: string[] = []
  for (const topic of topics ?? []) {
    if (typeof topic === "string" && topic) keywords.push(topic)
  }
  if (summary) {
    for (const key of ["techStack", "scenarios"] as const) {
      const list: unknown = summary?.[key]
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (typeof entry === "string" && entry) keywords.push(entry)
        }
      }
    }
  }
  return [...new Set(keywords)].slice(0, 12)
}

/**
 * Page through the repositories of one category collection.
 *
 * - `slug` identifies the category; ownership is enforced via `userId`.
 * - returns only `excluded=false` memberships, so manual/add and auto rows are
 *   visible and manually-excluded repositories are never leaked.
 * - `total` is the count matching the current search/language filters
 *   (excluded=false only); `category.repositoryCount` is the category-wide
 *   included count; `languages` lists every distinct language present in the
 *   category, for the language filter dropdown.
 */
export async function listCategoryRepositoriesForUser(
  userId: string,
  query: CategoryRepositoryQueryInput
): Promise<CategoryRepositoriesResult> {
  const { slug, search, language, sort, page, pageSize } =
    normalizeCategoryRepositoryQuery(query)

  const collection = await prisma.collection.findFirst({
    where: {
      userId,
      kind: "category",
      OR: [{ slug }, { id: slug }],
    },
    select: { id: true, slug: true, name: true, description: true },
  })
  if (!collection) throw new Error("Category not found")

  const membership = includedMembershipFilter(collection.id)

  // Repository rows are scoped to the session user, and must belong to the
  // category via a non-excluded membership link.
  const repositoryWhere = {
    userId,
    collectionLinks: { some: membership },
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { fullName: { contains: search, mode: "insensitive" as const } },
            { description: { contains: search, mode: "insensitive" as const } },
            { topics: { hasSome: [search] } },
          ],
        }
      : {}),
    ...(language ? { language } : {}),
  }

  const categoryWhere = {
    userId,
    collectionLinks: { some: membership },
  }

  const [total, repositoryCount, languageRows] = await Promise.all([
    prisma.repository.count({ where: repositoryWhere }),
    prisma.repository.count({ where: categoryWhere }),
    prisma.repository.findMany({
      where: { ...categoryWhere, language: { not: null } },
      select: { language: true },
      distinct: ["language"],
    }),
  ])

  const repos = await prisma.repository.findMany({
    where: repositoryWhere,
    orderBy: buildOrderBy(sort),
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: {
      collectionLinks: {
        where: { collectionId: collection.id },
        select: { source: true, excluded: true },
      },
    },
  })

  const repoIds = repos.map((r) => r.id)
  let analysesByRepoId = new Map<string, { status: string; result: unknown }>()
  if (repoIds.length > 0) {
    // Latest COMPLETED repo_summary only: a newer failed/running row must never
    // shadow an earlier successful summary. `extractSummaryText` below keeps
    // its status guard as defense-in-depth for any non-completed leftovers.
    const analyses = await prisma.analysis.findMany({
      where: {
        repositoryId: { in: repoIds },
        userId,
        analysisType: "repo_summary",
        status: "completed",
      },
      select: { repositoryId: true, status: true, result: true },
      distinct: ["repositoryId"],
      orderBy: { createdAt: "desc" },
    })
    analysesByRepoId = new Map(
      analyses.map((a) => [a.repositoryId!, { status: a.status, result: a.result }])
    )
  }

  const items = repos.map((repo): CategoryRepositoryItem => {
    const link = repo.collectionLinks?.[0] as IncludedLinkShape | undefined
    const analysis = analysesByRepoId.get(repo.id)
    const { oneLine, summary } = extractSummaryText(analysis)
    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.fullName,
      description: repo.description,
      url: repo.url,
      language: repo.language,
      stars: repo.stars,
      topics: repo.topics,
      note: repo.note,
      status: repo.status,
      summary: oneLine,
      updatedAt: repo.pushedAt?.toISOString() ?? repo.lastFetchedAt.toISOString(),
      classifierSource: link?.source === "manual" ? "manual" : "auto",
      keywords: buildKeywords(repo.topics, summary),
    }
  })

  const languages = languageRows
    .map((r) => r.language)
    .filter((l): l is string => Boolean(l))
    .sort((a, b) => a.localeCompare(b))

  return {
    category: {
      id: collection.id,
      slug: collection.slug ?? collection.id,
      name: collection.name,
      description: collection.description,
      repositoryCount,
    },
    items,
    total,
    page,
    pageSize,
    languages,
  }
}

// ── Manual membership control ─────────────────────────────────────

/**
 * Manually include (`included=true`) or exclude (`included=false`) a
 * repository in a category collection.
 *
 * The membership row is always forced to `source="manual"` so Agent A's
 * automatic (re)classification can never overwrite a manual decision:
 * - Including: upsert -> `{ source: "manual", excluded: false }`
 * - Excluding: upsert -> `{ source: "manual", excluded: true }` (even when the
 *   row was previously auto/included, it becomes manual-excluded).
 */
export async function setRepositoryCategoryMembershipForUser(
  userId: string,
  args: { repositoryId: string; slug: string; included: boolean }
): Promise<{ success: true }> {
  const { repositoryId, slug, included } = normalizeMembershipArgs(args)

  const [repo, collection] = await Promise.all([
    prisma.repository.findFirst({
      where: { id: repositoryId, userId },
      select: { id: true },
    }),
    prisma.collection.findFirst({
      where: { userId, kind: "category", OR: [{ slug }, { id: slug }] },
      select: { id: true },
    }),
  ])
  if (!repo) throw new Error("Repository not found")
  if (!collection) throw new Error("Category not found")

  await prisma.collectionRepository.upsert({
    where: {
      collectionId_repositoryId: {
        collectionId: collection.id,
        repositoryId,
      },
    },
    create: {
      collectionId: collection.id,
      repositoryId,
      source: "manual",
      excluded: !included,
    },
    update: {
      source: "manual",
      excluded: !included,
    },
  })

  return { success: true }
}