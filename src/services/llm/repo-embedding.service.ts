import crypto from "crypto"
import { embeddingsOpenAI } from "@/lib/embeddings"
import { prisma } from "@/lib/prisma"

const EMBEDDING_MODEL = "text-embedding-3-small"
const EMBEDDING_DIMENSIONS = 1536

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await embeddingsOpenAI.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8191),
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data[0].embedding
}

// ── Build embedding source text ──────────────────────────────────

async function buildEmbeddingText(repoId: string, userId: string): Promise<string | null> {
  const repo = await prisma.repository.findFirst({
    where: { id: repoId, userId },
    select: {
      name: true,
      fullName: true,
      description: true,
      language: true,
      topics: true,
    },
  })

  if (!repo) return null

  const analysis = await prisma.analysis.findFirst({
    where: { repositoryId: repoId, userId, analysisType: "repo_summary", status: "completed" },
    orderBy: { createdAt: "desc" },
    select: { result: true },
  })

  const result = analysis?.result as Record<string, unknown> | null
  const summary = result?.summary as Record<string, unknown> | null

  return [
    repo.name,
    repo.fullName,
    repo.description,
    repo.language,
    repo.topics.join(" "),
    summary?.oneLine ? `Summary: ${summary.oneLine}` : "",
    summary?.problem ? `Problem: ${summary.problem}` : "",
    summary?.simpleExplanation ? `Explanation: ${summary.simpleExplanation}` : "",
    summary?.reuseSuggestion ? `Reuse: ${summary.reuseSuggestion}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

// ── Generate & upsert embedding ──────────────────────────────────

export async function generateRepoEmbedding(
  repoId: string,
  userId: string
): Promise<boolean> {
  const text = await buildEmbeddingText(repoId, userId)
  if (!text) return false

  const embedding = await generateEmbedding(text)
  const vectorStr = `[${embedding.join(",")}]`
  const textHash = hashText(text)

  await prisma.$executeRawUnsafe(
    `INSERT INTO "RepoEmbedding" ("id", "repositoryId", "vector", "model", "textHash", "createdAt", "updatedAt")
     VALUES ($1, $2, $3::vector, $4, $5, NOW(), NOW())
     ON CONFLICT ("repositoryId") DO UPDATE
     SET "vector" = $3::vector, "model" = $4, "textHash" = $5, "updatedAt" = NOW()`,
    crypto.randomUUID(),
    repoId,
    vectorStr,
    EMBEDDING_MODEL,
    textHash
  )

  return true
}

// ── Semantic search ──────────────────────────────────────────────

export interface SearchResult {
  repoId: string
  fullName: string
  description: string | null
  language: string | null
  stars: number
  topics: string[]
  similarity: number
  summaryOneLine: string | null
}

export interface SearchFilters {
  language?: string
  minStars?: number
  topics?: string[]
}

export type SearchMode = "hybrid" | "semantic" | "keyword"

export type RepoSortKey = "relevance" | "stars" | "name" | "updated"

export interface RepoSearchPageResult {
  items: SearchResult[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface RepoSearchOptions {
  page?: number
  pageSize?: number
  sort?: RepoSortKey
  filters?: SearchFilters
}

type SearchRow = {
  repoId: string
  fullName: string
  description: string | null
  language: string | null
  stars: number
  topics: string[]
  similarity: number
  summaryOneLine: string | null
}

function buildFilterConditions(
  filters: SearchFilters | undefined,
  params: unknown[]
): string {
  const conditions: string[] = []
  if (filters?.language) {
    params.push(filters.language)
    conditions.push(`r."language" = $${params.length}`)
  }
  if (filters?.minStars != null && filters.minStars > 0) {
    params.push(filters.minStars)
    conditions.push(`r."stars" >= $${params.length}`)
  }
  if (filters?.topics && filters.topics.length > 0) {
    params.push(filters.topics)
    conditions.push(`r."topics" @> $${params.length}::text[]`)
  }
  return conditions.length > 0 ? "AND " + conditions.join(" AND ") : ""
}

const SEARCH_SELECT = `
  r."id" AS "repoId",
  r."fullName",
  r."description",
  r."language",
  r."stars",
  r."topics",
  (a."result"->'summary'->>'oneLine') AS "summaryOneLine"`

// The summary join must match the CURRENT user's analysis. The userId
// placeholder index differs per mode (keyword/semantic: $2; hybrid: $3),
// so the caller passes its own param position explicitly.
function buildSearchJoin(userIdParamIndex: number): string {
  return `
  LEFT JOIN LATERAL (
    SELECT "result" FROM "Analysis"
    WHERE "repositoryId" = r."id"
      AND "userId" = $${userIdParamIndex}
      AND "analysisType" = 'repo_summary'
      AND "status" = 'completed'
    ORDER BY "createdAt" DESC
    LIMIT 1
  ) a ON true`
}

// ── Numeric boundary guard (Server Action boundary) ──────────────

function normalizePage(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.floor(n) || 1)
}

function normalizePageSize(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 20
  return Math.min(Math.max(1, Math.floor(n)), 100)
}

interface RepoQueryBuild {
  rowsSql: string
  rowsParams: unknown[]
  countSql: string
  countParams: unknown[]
}

function buildRepoOrder(sort: RepoSortKey, relevanceExpr: string): string {
  switch (sort) {
    case "stars":
      return `ORDER BY r."stars" DESC, ${relevanceExpr} DESC`
    case "name":
      return `ORDER BY r."fullName" ASC`
    case "updated":
      return `ORDER BY r."updatedAt" DESC, ${relevanceExpr} DESC`
    case "relevance":
    default:
      return `ORDER BY ${relevanceExpr} DESC`
  }
}

function buildKeywordQuery(
  query: string,
  userId: string,
  page: number,
  pageSize: number,
  sort: RepoSortKey,
  filters: SearchFilters | undefined
): RepoQueryBuild {
  const params: unknown[] = [query, userId]
  const joinUserIdIndex = params.length
  const filterSql = buildFilterConditions(filters, params)
  const countParams = [...params]

  const relevance = `COALESCE(ts_rank(r."searchVector", websearch_to_tsquery('english', $1)), 0)`

  const offset = (page - 1) * pageSize
  const limitParam = params.length + 1
  const offsetClause = offset > 0 ? ` OFFSET $${limitParam + 1}` : ""
  const rowsSql =
    `SELECT ${SEARCH_SELECT}, ${relevance} AS "similarity"` +
    ` FROM "Repository" r` +
    buildSearchJoin(joinUserIdIndex) + `
    WHERE r."userId" = $2
      AND r."searchVector" @@ websearch_to_tsquery('english', $1)
      ${filterSql}
    ${buildRepoOrder(sort, '"similarity"')}
    LIMIT $${limitParam}${offsetClause}`
  params.push(pageSize)
  if (offset > 0) params.push(offset)

  const countSql =
    `SELECT COUNT(*)::int AS "total"
    FROM "Repository" r
    WHERE r."userId" = $2
      AND r."searchVector" @@ websearch_to_tsquery('english', $1)
      ${filterSql}`

  return { rowsSql, rowsParams: params, countSql, countParams }
}

function buildSemanticQuery(
  vectorStr: string,
  userId: string,
  page: number,
  pageSize: number,
  sort: RepoSortKey,
  filters: SearchFilters | undefined
): RepoQueryBuild {
  const params: unknown[] = [vectorStr, userId]
  const joinUserIdIndex = params.length
  const filterSql = buildFilterConditions(filters, params)
  const countParams = [...params]

  const relevance = `1 - (re."vector" <=> $1::vector)`

  const offset = (page - 1) * pageSize
  const limitParam = params.length + 1
  const offsetClause = offset > 0 ? ` OFFSET $${limitParam + 1}` : ""
  const rowsSql =
    `SELECT ${SEARCH_SELECT}, ${relevance} AS "similarity"` +
    ` FROM "RepoEmbedding" re
    JOIN "Repository" r ON r."id" = re."repositoryId"` +
    buildSearchJoin(joinUserIdIndex) + `
    WHERE r."userId" = $2
      AND ${relevance} > 0.3
      ${filterSql}
    ${buildRepoOrder(sort, '"similarity"')}
    LIMIT $${limitParam}${offsetClause}`
  params.push(pageSize)
  if (offset > 0) params.push(offset)

  const countSql =
    `SELECT COUNT(*)::int AS "total"
    FROM "RepoEmbedding" re
    JOIN "Repository" r ON r."id" = re."repositoryId"
    WHERE r."userId" = $2
      AND ${relevance} > 0.3
      ${filterSql}`

  return { rowsSql, rowsParams: params, countSql, countParams }
}

function buildHybridQuery(
  vectorStr: string,
  query: string,
  userId: string,
  page: number,
  pageSize: number,
  sort: RepoSortKey,
  filters: SearchFilters | undefined
): RepoQueryBuild {
  const params: unknown[] = [vectorStr, query, userId]
  const joinUserIdIndex = params.length // hybrid: $1=vector, $2=query, $3=userId
  const filterSql = buildFilterConditions(filters, params)
  const countParams = [...params]

  const similarity = `1 - (re."vector" <=> $1::vector)`
  const textRank = `COALESCE(ts_rank(r."searchVector", websearch_to_tsquery('english', $2)), 0)`
  const relevance = `(${similarity}) * 0.7 + ${textRank} * 0.3`

  const offset = (page - 1) * pageSize
  const limitParam = params.length + 1
  const offsetClause = offset > 0 ? ` OFFSET $${limitParam + 1}` : ""
  const rowsSql =
    `SELECT ${SEARCH_SELECT}, ${similarity} AS "similarity", ${relevance} AS "hybridScore"` +
    ` FROM "RepoEmbedding" re
    JOIN "Repository" r ON r."id" = re."repositoryId"` +
    buildSearchJoin(joinUserIdIndex) + `
    WHERE r."userId" = $3
      AND (${similarity} > 0.3 OR r."searchVector" @@ websearch_to_tsquery('english', $2))
      ${filterSql}
    ${buildRepoOrder(sort, '"hybridScore"')}
    LIMIT $${limitParam}${offsetClause}`
  params.push(pageSize)
  if (offset > 0) params.push(offset)

  const countSql =
    `SELECT COUNT(*)::int AS "total"
    FROM "RepoEmbedding" re
    JOIN "Repository" r ON r."id" = re."repositoryId"
    WHERE r."userId" = $3
      AND (${similarity} > 0.3 OR r."searchVector" @@ websearch_to_tsquery('english', $2))
      ${filterSql}`

  return { rowsSql, rowsParams: params, countSql, countParams }
}

export async function searchReposByText(
  query: string,
  userId: string,
  limit = 20,
  filters?: SearchFilters,
  searchMode: SearchMode = "hybrid"
): Promise<SearchResult[]> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery || !userId.trim() || !Number.isFinite(limit) || limit <= 0) return []

  const normalizedLimit = Math.min(Math.floor(limit), 100)
  let build: RepoQueryBuild

  if (searchMode === "keyword") {
    // Pure full-text search — no embedding API call
    build = buildKeywordQuery(normalizedQuery, userId, 1, normalizedLimit, "relevance", filters)
  } else if (searchMode === "semantic") {
    const embedding = await generateEmbedding(normalizedQuery)
    const vectorStr = `[${embedding.join(",")}]`
    build = buildSemanticQuery(vectorStr, userId, 1, normalizedLimit, "relevance", filters)
  } else {
    // hybrid (default) — semantic + keyword weighted fusion
    const embedding = await generateEmbedding(normalizedQuery)
    const vectorStr = `[${embedding.join(",")}]`
    build = buildHybridQuery(vectorStr, normalizedQuery, userId, 1, normalizedLimit, "relevance", filters)
  }

  return prisma.$queryRawUnsafe<SearchRow[]>(build.rowsSql, ...build.rowsParams)
}

// ── Paginated, sortable repo search ──────────────────────────────

export async function searchReposPage(
  query: string,
  userId: string,
  options: RepoSearchOptions = {},
  searchMode: SearchMode = "hybrid"
): Promise<RepoSearchPageResult> {
  const normalizedQuery = query.trim()
  const page = normalizePage(options.page)
  const pageSize = normalizePageSize(options.pageSize)
  const sort: RepoSortKey = options.sort ?? "relevance"

  const empty: RepoSearchPageResult = { items: [], total: 0, page, pageSize, hasMore: false }
  if (!normalizedQuery || !userId.trim()) return empty

  let build: RepoQueryBuild
  if (searchMode === "keyword") {
    build = buildKeywordQuery(normalizedQuery, userId, page, pageSize, sort, options.filters)
  } else if (searchMode === "semantic") {
    const embedding = await generateEmbedding(normalizedQuery)
    const vectorStr = `[${embedding.join(",")}]`
    build = buildSemanticQuery(vectorStr, userId, page, pageSize, sort, options.filters)
  } else {
    const embedding = await generateEmbedding(normalizedQuery)
    const vectorStr = `[${embedding.join(",")}]`
    build = buildHybridQuery(vectorStr, normalizedQuery, userId, page, pageSize, sort, options.filters)
  }

  const [items, totalRows] = await Promise.all([
    prisma.$queryRawUnsafe<SearchRow[]>(build.rowsSql, ...build.rowsParams),
    prisma.$queryRawUnsafe<{ total: number }[]>(build.countSql, ...build.countParams),
  ])

  const total = totalRows?.[0]?.total ?? 0
  return { items, total, page, pageSize, hasMore: page * pageSize < total }
}

// ── Similar repos ────────────────────────────────────────────────

export async function getSimilarRepos(
  repoId: string,
  userId: string,
  limit = 5
): Promise<SearchResult[]> {
  const results = await prisma.$queryRawUnsafe<
    Array<{
      repoId: string
      fullName: string
      description: string | null
      language: string | null
      stars: number
      topics: string[]
      similarity: number
      summaryOneLine: string | null
    }>
  >(
    `SELECT
       r."id" AS "repoId",
       r."fullName",
       r."description",
       r."language",
       r."stars",
       r."topics",
       1 - (re."vector" <=> target."vector") AS "similarity",
       (a."result"->'summary'->>'oneLine') AS "summaryOneLine"
     FROM "RepoEmbedding" re
     JOIN "Repository" r ON r."id" = re."repositoryId"
     JOIN "RepoEmbedding" target ON target."repositoryId" = $1
     JOIN "Repository" targetRepo
       ON targetRepo."id" = target."repositoryId" AND targetRepo."userId" = $2
     LEFT JOIN LATERAL (
       SELECT "result" FROM "Analysis"
       WHERE "repositoryId" = r."id"
         AND "userId" = $2
         AND "analysisType" = 'repo_summary'
         AND "status" = 'completed'
       ORDER BY "createdAt" DESC
       LIMIT 1
     ) a ON true
     WHERE r."userId" = $2
       AND r."id" != $1
       AND 1 - (re."vector" <=> target."vector") > 0.3
     ORDER BY re."vector" <=> target."vector"
     LIMIT $3`,
    repoId,
    userId,
    limit
  )

  return results
}

// ── Embedding freshness ──────────────────────────────────────────

export interface EmbeddingFreshness {
  hasEmbedding: boolean
  isStale: boolean
  embeddedAt: string | null
  lastSummaryAt: string | null
}

export async function checkEmbeddingFreshness(
  repoId: string,
  userId: string
): Promise<EmbeddingFreshness> {
  const [embedding, analysis] = await Promise.all([
    prisma.repoEmbedding.findUnique({
      where: { repositoryId: repoId },
      select: { textHash: true, updatedAt: true },
    }),
    prisma.analysis.findFirst({
      where: { repositoryId: repoId, userId, analysisType: "repo_summary", status: "completed" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ])

  const lastSummaryAt = analysis?.createdAt.toISOString() ?? null

  if (!embedding) {
    return { hasEmbedding: false, isStale: false, embeddedAt: null, lastSummaryAt }
  }

  const embeddedAt = embedding.updatedAt.toISOString()

  // Exact check: rebuild text and compare hash
  const currentText = await buildEmbeddingText(repoId, userId)
  const currentHash = currentText ? hashText(currentText) : null
  const hashMismatch = currentHash !== null && currentHash !== embedding.textHash

  // Timestamp check: analysis newer than embedding
  const timestampsStale = analysis && embedding.updatedAt < analysis.createdAt

  return {
    hasEmbedding: true,
    isStale: hashMismatch || !!timestampsStale,
    embeddedAt,
    lastSummaryAt,
  }
}

export async function checkEmbeddingFreshnessBatch(
  repoIds: string[],
  userId: string
): Promise<Map<string, EmbeddingFreshness>> {
  if (repoIds.length === 0) return new Map()

  const [embeddings, analyses] = await Promise.all([
    prisma.repoEmbedding.findMany({
      where: { repositoryId: { in: repoIds } },
      select: { repositoryId: true, updatedAt: true },
    }),
    prisma.analysis.findMany({
      where: {
        repositoryId: { in: repoIds },
        userId,
        analysisType: "repo_summary",
        status: "completed",
      },
      select: { repositoryId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  const embeddingMap = new Map(embeddings.map((e) => [e.repositoryId, e.updatedAt]))
  const analysisMap = new Map<string, Date>()
  for (const a of analyses) {
    if (!analysisMap.has(a.repositoryId!)) {
      analysisMap.set(a.repositoryId!, a.createdAt)
    }
  }

  const result = new Map<string, EmbeddingFreshness>()
  for (const repoId of repoIds) {
    const embeddedAt = embeddingMap.get(repoId)
    const analysisCreatedAt = analysisMap.get(repoId)
    const hasEmbedding = !!embeddedAt
    const isStale = hasEmbedding && analysisCreatedAt != null && embeddedAt! < analysisCreatedAt

    result.set(repoId, {
      hasEmbedding,
      isStale,
      embeddedAt: embeddedAt?.toISOString() ?? null,
      lastSummaryAt: analysisCreatedAt?.toISOString() ?? null,
    })
  }

  return result
}
