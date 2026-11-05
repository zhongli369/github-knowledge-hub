// Input validation for category-collection queries and mutations.
// No user input is ever interpolated into raw SQL; these helpers normalize and
// bound the values that are later used as Prisma parameters.

export const CATEGORY_SORTS = ["stars", "updated", "name"] as const
export type CategorySort = (typeof CATEGORY_SORTS)[number]

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

const MAX_SLUG_LENGTH = 200
const MAX_SEARCH_LENGTH = 200
const MAX_LANGUAGE_LENGTH = 64

export interface NormalizedCategoryRepositoryQuery {
  slug: string
  search?: string
  language?: string
  sort: CategorySort
  page: number
  pageSize: number
}

/**
 * Normalize the client-supplied category repository query:
 * - `slug` is required (category identity).
 * - `sort` is whitelisted; unknown values fall back to "updated".
 * - `page` >= 1, `pageSize` in [1, MAX_PAGE_SIZE] (default DEFAULT_PAGE_SIZE).
 * - free-text inputs are trimmed and length-capped.
 */
export function normalizeCategoryRepositoryQuery(query: {
  slug: string
  search?: string
  language?: string
  sort?: string
  page?: number
  pageSize?: number
}): NormalizedCategoryRepositoryQuery {
  const slug = query.slug?.trim()
  if (!slug) throw new Error("Category slug is required")
  if (slug.length > MAX_SLUG_LENGTH) throw new Error("Category slug is too long")

  const search = query.search?.trim()
  if (search && search.length > MAX_SEARCH_LENGTH) throw new Error("Search query is too long")

  const language = query.language?.trim() || undefined
  if (language && language.length > MAX_LANGUAGE_LENGTH) throw new Error("Language filter is too long")

  const sort: CategorySort =
    query.sort && (CATEGORY_SORTS as readonly string[]).includes(query.sort)
      ? (query.sort as CategorySort)
      : "updated"

  const page = Number.isInteger(query.page) && (query.page as number) >= 1 ? (query.page as number) : 1

  // Values above the maximum are clamped (limit max 100), invalid values fall
  // back to the default.
  const pageSize =
    Number.isInteger(query.pageSize) && (query.pageSize as number) >= 1
      ? Math.min(query.pageSize as number, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE

  return { slug, search, language, sort, page, pageSize }
}

export interface NormalizedMembershipArgs {
  repositoryId: string
  slug: string
  included: boolean
}

/** Normalize and validate `setRepositoryCategoryMembership` arguments. */
export function normalizeMembershipArgs(args: {
  repositoryId: string
  slug: string
  included: boolean
}): NormalizedMembershipArgs {
  if (!args || typeof args !== "object") throw new Error("Invalid arguments")

  const repositoryId = args.repositoryId?.trim()
  if (!repositoryId) throw new Error("repositoryId is required")

  const slug = args.slug?.trim()
  if (!slug) throw new Error("Category slug is required")

  if (typeof args.included !== "boolean") throw new Error("included must be a boolean")

  return { repositoryId, slug, included: args.included }
}