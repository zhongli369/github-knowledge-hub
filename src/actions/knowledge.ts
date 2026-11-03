"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { enqueueAssetExtraction, type EnqueueResult } from "@/services/intake"
import {
  searchByText,
  getSimilarAssets as getSimilarAssetsSvc,
  type AssetSearchFilters,
} from "@/services/llm/embeddings.service"

export async function extractAssetsAction(
  repositoryId: string
): Promise<EnqueueResult> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return enqueueAssetExtraction(repositoryId, session.user.id)
}

export async function getAllUserAssetsAction() {
  const session = await auth()
  if (!session?.user?.id) return []
  return prisma.knowledgeAsset.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
}

export async function getRepoAssetsAction(
  repositoryId: string
) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return prisma.knowledgeAsset.findMany({
    where: { repositoryId, userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  })
}

// ── Asset search ─────────────────────────────────────────────────

export async function searchAssetsAction(
  query: string,
  filters?: AssetSearchFilters,
  limit?: number
) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return searchByText(query, session.user.id, limit ?? 20, filters)
}

export async function getSimilarAssetsAction(assetId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return getSimilarAssetsSvc(assetId, session.user.id, 5)
}

export async function getAssetDetailAction(assetId: string) {
  const session = await auth()
  if (!session?.user?.id) return null
  return prisma.knowledgeAsset.findFirst({
    where: { id: assetId, userId: session.user.id },
    include: { repository: { select: { id: true, fullName: true } } },
  })
}

export async function getAssetFilterOptions() {
  const session = await auth()
  if (!session?.user?.id) return { languages: [], difficulties: [] }

  const [langResults, diffResults] = await Promise.all([
    prisma.knowledgeAsset.findMany({
      where: { userId: session.user.id, language: { not: null } },
      select: { language: true },
      distinct: ["language"],
    }),
    prisma.knowledgeAsset.findMany({
      where: { userId: session.user.id, difficulty: { not: null } },
      select: { difficulty: true },
      distinct: ["difficulty"],
    }),
  ])

  return {
    languages: langResults.map((r) => r.language!).filter(Boolean).sort(),
    difficulties: diffResults.map((r) => r.difficulty!).filter(Boolean).sort(),
  }
}
