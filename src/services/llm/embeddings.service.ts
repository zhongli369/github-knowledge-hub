import crypto from "crypto"
import { embeddingsOpenAI } from "@/lib/embeddings"
import { prisma } from "@/lib/prisma"

const EMBEDDING_MODEL = "text-embedding-3-small"
const EMBEDDING_DIMENSIONS = 1536

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await embeddingsOpenAI.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8191),
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data[0].embedding
}

export async function embedKnowledgeAsset(
  assetId: string,
  content: string
): Promise<void> {
  const embedding = await generateEmbedding(content)
  const vectorStr = `[${embedding.join(",")}]`

  await prisma.$executeRawUnsafe(
    `INSERT INTO "Embedding" ("id", "assetId", "vector", "model", "createdAt")
     VALUES ($1, $2, $3::vector, $4, NOW())
     ON CONFLICT ("assetId") DO UPDATE
     SET "vector" = $3::vector, "model" = $4, "createdAt" = NOW()`,
    crypto.randomUUID(),
    assetId,
    vectorStr,
    EMBEDDING_MODEL
  )
}

// ── Asset search types ───────────────────────────────────────────

export interface AssetSearchFilters {
  assetType?: string
  language?: string
  difficulty?: string
  tags?: string[]
}

export interface AssetSearchResult {
  assetId: string
  title: string
  description: string | null
  assetType: string
  language: string | null
  tags: string[]
  difficulty: string | null
  summary: string | null
  sourcePath: string | null
  repositoryId: string
  repoFullName: string
  similarity: number
}

export type AssetSortKey = "relevance" | "title" | "updated"

export interface AssetSearchPageResult {
  items: AssetSearchResult[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface AssetSearchOptions {
  page?: number
  pageSize?: number
  sort?: AssetSortKey
  filters?: AssetSearchFilters
  threshold?: number
}

// ── Internal helper ──────────────────────────────────────────────

function buildAssetFilterConditions(
  filters: AssetSearchFilters | undefined,
  params: unknown[]
): string {
  const conditions: string[] = []
  if (filters?.assetType) {
    params.push(filters.assetType)
    conditions.push(`ka."assetType" = $${params.length}`)
  }
  if (filters?.language) {
    params.push(filters.language)
    conditions.push(`ka."language" = $${params.length}`)
  }
  if (filters?.difficulty) {
    params.push(filters.difficulty)
    conditions.push(`ka."difficulty" = $${params.length}`)
  }
  if (filters?.tags && filters.tags.length > 0) {
    params.push(filters.tags)
    conditions.push(`ka."tags" @> $${params.length}::text[]`)
  }
  return conditions.length > 0 ? "AND " + conditions.join(" AND ") : ""
}

// ── Numeric boundary guard (Server Action boundary) ──────────────

function normalizePage(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.floor(n) || 1)
}

function normalizePageSize(raw: unknown, fallback = 20): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(1, Math.floor(n)), 100)
}

function normalizeLimit(raw: unknown, fallback = 10): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), 100)
}

function normalizeThreshold(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0.3
  return Math.min(Math.max(0, n), 1)
}

// ── Core search ──────────────────────────────────────────────────

interface AssetQueryBuild {
  rowsSql: string
  rowsParams: unknown[]
  countSql: string
  countParams: unknown[]
}

const ASSET_SELECT = `
  ka."id" AS "assetId",
  ka."title",
  ka."description",
  ka."assetType",
  ka."language",
  ka."tags",
  ka."difficulty",
  ka."summary",
  ka."sourcePath",
  ka."repositoryId",
  r."fullName" AS "repoFullName",
  1 - (e."vector" <=> $1::vector) AS "similarity"`

const ASSET_FROM = `
  FROM "Embedding" e
  JOIN "KnowledgeAsset" ka ON ka."id" = e."assetId"
  JOIN "Repository" r ON r."id" = ka."repositoryId"`

function buildAssetOrder(sort: AssetSortKey): string {
  switch (sort) {
    case "title":
      return `ORDER BY ka."title" ASC`
    case "updated":
      return `ORDER BY ka."updatedAt" DESC`
    case "relevance":
    default:
      return `ORDER BY 1 - (e."vector" <=> $1::vector) DESC`
  }
}

function buildAssetSearchQuery(
  vectorStr: string,
  userId: string,
  page: number,
  pageSize: number,
  sort: AssetSortKey,
  filters: AssetSearchFilters | undefined,
  threshold = 0.3
): AssetQueryBuild {
  const params: unknown[] = [vectorStr, userId]
  const filterSql = buildAssetFilterConditions(filters, params)
  const thresholdIndex = params.length + 1
  params.push(threshold)
  const countParams = [...params]

  const whereSql = `
    WHERE ka."userId" = $2
      AND 1 - (e."vector" <=> $1::vector) > $${thresholdIndex}
      ${filterSql}`

  const offset = (page - 1) * pageSize
  const limitParam = params.length + 1
  const offsetClause = offset > 0 ? ` OFFSET $${limitParam + 1}` : ""
  const rowsSql =
    `SELECT ${ASSET_SELECT}` +
    ASSET_FROM +
    whereSql + `
    ${buildAssetOrder(sort)}
    LIMIT $${limitParam}${offsetClause}`
  params.push(pageSize)
  if (offset > 0) params.push(offset)

  const countSql = `SELECT COUNT(*)::int AS "total"` + ASSET_FROM + whereSql

  return { rowsSql, rowsParams: params, countSql, countParams }
}

export async function searchSimilarAssets(
  embedding: number[],
  userId: string,
  limit = 10,
  filters?: AssetSearchFilters,
  threshold = 0.3
): Promise<AssetSearchResult[]> {
  const normalizedLimit = normalizeLimit(limit)
  const normalizedThreshold = normalizeThreshold(threshold)
  const vectorStr = `[${embedding.join(",")}]`
  const build = buildAssetSearchQuery(
    vectorStr,
    userId,
    1,
    normalizedLimit,
    "relevance",
    filters,
    normalizedThreshold,
  )
  return prisma.$queryRawUnsafe<AssetSearchResult[]>(build.rowsSql, ...build.rowsParams)
}

export async function searchByText(
  query: string,
  userId: string,
  limit = 10,
  filters?: AssetSearchFilters,
  threshold = 0.3
): Promise<AssetSearchResult[]> {
  const embedding = await generateEmbedding(query)
  return searchSimilarAssets(embedding, userId, limit, filters, threshold)
}

// ── Paginated, sortable asset search ─────────────────────────────

export async function searchAssetsPage(
  query: string,
  userId: string,
  options: AssetSearchOptions = {}
): Promise<AssetSearchPageResult> {
  const normalizedQuery = query.trim()
  const page = normalizePage(options.page)
  const pageSize = normalizePageSize(options.pageSize)
  const sort: AssetSortKey = options.sort ?? "relevance"
  const threshold = normalizeThreshold(options.threshold)

  const empty: AssetSearchPageResult = { items: [], total: 0, page, pageSize, hasMore: false }
  if (!normalizedQuery || !userId.trim()) return empty

  const embedding = await generateEmbedding(normalizedQuery)
  const vectorStr = `[${embedding.join(",")}]`
  const build = buildAssetSearchQuery(vectorStr, userId, page, pageSize, sort, options.filters, threshold)

  const [items, totalRows] = await Promise.all([
    prisma.$queryRawUnsafe<AssetSearchResult[]>(build.rowsSql, ...build.rowsParams),
    prisma.$queryRawUnsafe<{ total: number }[]>(build.countSql, ...build.countParams),
  ])

  const total = totalRows?.[0]?.total ?? 0
  return { items, total, page, pageSize, hasMore: page * pageSize < total }
}

// ── Similar assets ───────────────────────────────────────────────

export async function getSimilarAssets(
  assetId: string,
  userId: string,
  limit = 5
): Promise<AssetSearchResult[]> {
  // Check if source asset has an embedding
  const target = await prisma.embedding.findUnique({
    where: { assetId },
    select: { assetId: true },
  })
  if (!target) return []

  const results = await prisma.$queryRawUnsafe<AssetSearchResult[]>(
    `SELECT
       ka."id" AS "assetId",
       ka."title",
       ka."description",
       ka."assetType",
       ka."language",
       ka."tags",
       ka."difficulty",
       ka."summary",
       ka."sourcePath",
       ka."repositoryId",
       r."fullName" AS "repoFullName",
       1 - (e."vector" <=> target."vector") AS "similarity"
     FROM "Embedding" e
     JOIN "KnowledgeAsset" ka ON ka."id" = e."assetId"
     JOIN "Repository" r ON r."id" = ka."repositoryId"
     JOIN "Embedding" target ON target."assetId" = $1
     JOIN "KnowledgeAsset" targetAsset
       ON targetAsset."id" = target."assetId" AND targetAsset."userId" = $2
     WHERE ka."userId" = $2
       AND ka."id" != $1
       AND 1 - (e."vector" <=> target."vector") > 0.3
     ORDER BY e."vector" <=> target."vector"
     LIMIT $3`,
    assetId,
    userId,
    limit
  )

  return results
}
