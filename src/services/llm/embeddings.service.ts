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

// ── Core search ──────────────────────────────────────────────────

export async function searchSimilarAssets(
  embedding: number[],
  userId: string,
  limit = 10,
  filters?: AssetSearchFilters,
  threshold = 0.3
): Promise<AssetSearchResult[]> {
  const vectorStr = `[${embedding.join(",")}]`
  const params: unknown[] = [vectorStr, userId]

  const filterSql = buildAssetFilterConditions(filters, params)

  params.push(threshold, limit)

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
       1 - (e."vector" <=> $1::vector) AS "similarity"
     FROM "Embedding" e
     JOIN "KnowledgeAsset" ka ON ka."id" = e."assetId"
     JOIN "Repository" r ON r."id" = ka."repositoryId"
     WHERE ka."userId" = $2
       AND 1 - (e."vector" <=> $1::vector) > $${params.length - 1}
       ${filterSql}
     ORDER BY e."vector" <=> $1::vector
     LIMIT $${params.length}`,
    ...params
  )

  return results
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
