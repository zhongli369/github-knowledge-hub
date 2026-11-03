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

const SEARCH_JOIN = `
  LEFT JOIN LATERAL (
    SELECT "result" FROM "Analysis"
    WHERE "repositoryId" = r."id"
      AND "userId" = $2
      AND "analysisType" = 'repo_summary'
      AND "status" = 'completed'
    ORDER BY "createdAt" DESC
    LIMIT 1
  ) a ON true`

function searchSemantic(
  vectorStr: string,
  userId: string,
  limit: number,
  filters: SearchFilters | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [vectorStr, userId]
  const filterSql = buildFilterConditions(filters, params)
  params.push(limit)
  const limitIdx = params.length

  const sql = `
    SELECT
      ${SEARCH_SELECT},
      1 - (re."vector" <=> $1::vector) AS "similarity"
    FROM "RepoEmbedding" re
    JOIN "Repository" r ON r."id" = re."repositoryId"
    ${SEARCH_JOIN}
    WHERE r."userId" = $2
      AND 1 - (re."vector" <=> $1::vector) > 0.3
      ${filterSql}
    ORDER BY re."vector" <=> $1::vector
    LIMIT $${limitIdx}`

  return { sql, params }
}

function searchKeyword(
  query: string,
  userId: string,
  limit: number,
  filters: SearchFilters | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [query, userId]
  const filterSql = buildFilterConditions(filters, params)
  params.push(limit)
  const limitIdx = params.length

  const sql = `
    SELECT
      ${SEARCH_SELECT},
      COALESCE(ts_rank(r."searchVector", websearch_to_tsquery('english', $1)), 0) AS "similarity"
    FROM "Repository" r
    ${SEARCH_JOIN}
    WHERE r."userId" = $2
      AND r."searchVector" @@ websearch_to_tsquery('english', $1)
      ${filterSql}
    ORDER BY "similarity" DESC
    LIMIT $${limitIdx}`

  return { sql, params }
}

function searchHybrid(
  vectorStr: string,
  query: string,
  userId: string,
  limit: number,
  filters: SearchFilters | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [vectorStr, query, userId]
  const filterSql = buildFilterConditions(filters, params)
  params.push(limit)
  const limitIdx = params.length

  const sql = `
    SELECT
      ${SEARCH_SELECT},
      1 - (re."vector" <=> $1::vector) AS "similarity",
      ts_rank(r."searchVector", websearch_to_tsquery('english', $2)) AS "textRank",
      (1 - (re."vector" <=> $1::vector)) * 0.7 +
        COALESCE(ts_rank(r."searchVector", websearch_to_tsquery('english', $2)), 0) * 0.3
        AS "hybridScore"
    FROM "RepoEmbedding" re
    JOIN "Repository" r ON r."id" = re."repositoryId"
    ${SEARCH_JOIN}
    WHERE r."userId" = $3
      AND (
        1 - (re."vector" <=> $1::vector) > 0.3
        OR r."searchVector" @@ websearch_to_tsquery('english', $2)
      )
      ${filterSql}
    ORDER BY "hybridScore" DESC
    LIMIT $${limitIdx}`

  return { sql, params }
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
  let sql: string
  let params: unknown[]

  if (searchMode === "keyword") {
    // Pure full-text search — no embedding API call
    ;({ sql, params } = searchKeyword(normalizedQuery, userId, normalizedLimit, filters))
  } else if (searchMode === "semantic") {
    const embedding = await generateEmbedding(normalizedQuery)
    const vectorStr = `[${embedding.join(",")}]`
    ;({ sql, params } = searchSemantic(vectorStr, userId, normalizedLimit, filters))
  } else {
    // hybrid (default) — semantic + keyword weighted fusion
    const embedding = await generateEmbedding(normalizedQuery)
    const vectorStr = `[${embedding.join(",")}]`
    ;({ sql, params } = searchHybrid(vectorStr, normalizedQuery, userId, normalizedLimit, filters))
  }

  const results = await prisma.$queryRawUnsafe<SearchRow[]>(sql, ...params)
  return results
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
