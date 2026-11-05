"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { REPO_CATEGORY_BY_SLUG } from "@/lib/classification/taxonomy"
import {
  listCategoryCollectionsForUser,
  listCategoryRepositoriesForUser,
  setRepositoryCategoryMembershipForUser,
} from "@/lib/collections/category"

import type {
  CategoryCollectionSummary,
  CategoryRepositoriesResult,
  CategoryRepositoryQuery,
} from "@/lib/collections/category"

export type {
  CategoryCollectionSummary,
  CategoryRepositoriesResult,
  CategoryRepositoryItem,
  CategoryRepositoryQuery,
} from "@/lib/collections/category"

// ── Queries ───────────────────────────────────────────────────────

export async function getCollectionsAction() {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return prisma.collection.findMany({
    where: { userId: session.user.id, kind: "custom" },
    include: { _count: { select: { assets: true } } },
    orderBy: { updatedAt: "desc" },
  })
}

export async function getCollectionDetailAction(collectionId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return prisma.collection.findFirst({
    where: { id: collectionId, userId: session.user.id },
    include: {
      assets: {
        include: { asset: true },
        // Explicit user order wins; legacy rows (sortOrder 0) fall back to newest-first.
        orderBy: [{ sortOrder: "asc" }, { addedAt: "desc" }],
      },
    },
  })
}

// ── Mutations ─────────────────────────────────────────────────────

export async function createCollectionAction(name: string, description?: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const trimmedName = name?.trim()
  if (!trimmedName) throw new Error("Collection name is required")

  const collection = await prisma.collection.create({
    data: {
      name: trimmedName,
      description: description?.trim() || null,
      userId: session.user.id,
    },
  })

  revalidatePath("/collections")
  return collection
}

export async function updateCollectionAction(
  collectionId: string,
  data: { name: string; description?: string | null }
) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const name = data.name?.trim()
  if (!name) throw new Error("Collection name is required")

  // Verify the current user owns the collection before mutating it.
  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: session.user.id },
    select: { id: true },
  })
  if (!collection) throw new Error("Collection not found")

  const description = data.description == null ? null : data.description.trim() || null

  const updated = await prisma.collection.update({
    where: { id: collectionId },
    data: { name, description },
  })

  revalidatePath("/collections")
  revalidatePath(`/collections/${collectionId}`)
  return updated
}

export async function deleteCollectionAction(collectionId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  // Verify ownership before deleting.
  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: session.user.id },
    select: { id: true },
  })
  if (!collection) throw new Error("Collection not found")

  await prisma.collection.delete({ where: { id: collectionId } })
  revalidatePath("/collections")
  return { success: true }
}

export async function addAssetsToCollectionAction(
  collectionId: string,
  assetIdsInput: string[]
): Promise<{ added: number; alreadyInCollection: number; collectionName: string }> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const assetIds = [...new Set(assetIdsInput)]
  if (assetIds.length === 0) {
    return { added: 0, alreadyInCollection: 0, collectionName: "" }
  }

  // Verify the current user owns both the collection and every asset (fail closed).
  const [collection, assets] = await Promise.all([
    prisma.collection.findFirst({
      where: { id: collectionId, userId: session.user.id },
      select: { id: true, name: true },
    }),
    prisma.knowledgeAsset.findMany({
      where: { id: { in: assetIds }, userId: session.user.id },
      select: { id: true },
    }),
  ])
  if (!collection) throw new Error("Collection not found")
  if (assets.length !== assetIds.length) throw new Error("Asset not found")

  // New assets keep the existing "newest first" UX while staying in selection order:
  // negative sortOrder values sort above existing entries (ascending).
  const data = assetIds.map((assetId, index) => ({
    collectionId,
    assetId,
    sortOrder: index - assetIds.length,
  }))

  const result = await prisma.collectionAsset.createMany({
    data,
    skipDuplicates: true,
  })

  revalidatePath(`/collections/${collectionId}`)
  return {
    added: result.count,
    alreadyInCollection: assetIds.length - result.count,
    collectionName: collection.name,
  }
}

export async function removeAssetsFromCollectionAction(
  collectionId: string,
  assetIdsInput: string[]
): Promise<{ removed: number }> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const assetIds = [...new Set(assetIdsInput)]
  if (assetIds.length === 0) return { removed: 0 }

  // Verify both the collection and every asset are owned by the current user,
  // and that the asset is actually linked into this collection (fail closed).
  const [collection, links, ownedAssets] = await Promise.all([
    prisma.collection.findFirst({
      where: { id: collectionId, userId: session.user.id },
      select: { id: true },
    }),
    prisma.collectionAsset.findMany({
      where: { collectionId, assetId: { in: assetIds } },
      select: { assetId: true },
    }),
    prisma.knowledgeAsset.findMany({
      where: { id: { in: assetIds }, userId: session.user.id },
      select: { id: true },
    }),
  ])
  if (!collection) throw new Error("Collection not found")
  if (links.length !== assetIds.length || ownedAssets.length !== assetIds.length) {
    throw new Error("Asset not in collection")
  }

  const result = await prisma.collectionAsset.deleteMany({
    where: { collectionId, assetId: { in: assetIds } },
  })

  revalidatePath(`/collections/${collectionId}`)
  return { removed: result.count }
}

export async function reorderCollectionAssetsAction(
  collectionId: string,
  orderedAssetIds: string[]
) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const [collection, links, ownedAssets] = await Promise.all([
    prisma.collection.findFirst({
      where: { id: collectionId, userId: session.user.id },
      select: { id: true },
    }),
    prisma.collectionAsset.findMany({
      where: { collectionId },
      select: { assetId: true },
    }),
    prisma.knowledgeAsset.findMany({
      where: { id: { in: orderedAssetIds }, userId: session.user.id },
      select: { id: true },
    }),
  ])
  if (!collection) throw new Error("Collection not found")

  // The new order must be exactly the owned assets currently in the (user-scoped) collection.
  const linked = new Set(links.map((l) => l.assetId))
  if (orderedAssetIds.length !== linked.size) throw new Error("Order must include every asset in the collection")
  if (ownedAssets.length !== orderedAssetIds.length) throw new Error("Asset not in collection")
  for (const assetId of orderedAssetIds) {
    if (!linked.has(assetId)) throw new Error("Asset not in collection")
  }

  await prisma.$transaction(
    orderedAssetIds.map((assetId, index) =>
      prisma.collectionAsset.updateMany({
        where: { collectionId, assetId },
        data: { sortOrder: index },
      })
    )
  )

  revalidatePath(`/collections/${collectionId}`)
  return { success: true }
}

// ── Single-item helpers (kept for the library page and asset picker) ──

export async function addToCollectionAction(collectionId: string, assetId: string) {
  const result = await addAssetsToCollectionAction(collectionId, [assetId])
  return {
    status: result.added === 1 ? "added" : "already_in_collection",
    collectionName: result.collectionName,
  }
}

export async function removeFromCollectionAction(collectionId: string, assetId: string) {
  const result = await removeAssetsFromCollectionAction(collectionId, [assetId])
  revalidatePath(`/collections/${collectionId}`)
  return { success: true, removed: result.removed }
}

// ── Category collections (kind="category") ───────────────────────
// Business logic lives in @/lib/collections/category with an explicit userId
// parameter so it is unit-testable and every query/write is user-scoped. These
// server actions resolve the authed session id and delegate; they never accept
// a userId/repositoryId/collectionId without validating ownership.

/**
 * List the current user's category collections plus their included-repo counts.
 * Stable slugs identify categories; locale selects the taxonomy's display name
 * and description without renaming the persisted Collection rows.
 */
export async function listCategoryCollections(
  locale?: string
): Promise<CategoryCollectionSummary[]> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  const { ensureCategoryCollections } = await import("@/lib/classification/service")
  await ensureCategoryCollections(session.user.id)
  const categories = await listCategoryCollectionsForUser(session.user.id)
  if (!locale?.toLowerCase().startsWith("en")) return categories

  return categories.map((category) => {
    const definition = REPO_CATEGORY_BY_SLUG[category.slug]
    if (!definition) return category
    return {
      ...category,
      name: definition.nameEn,
      description: definition.descriptionEn,
    }
  })
}

/**
 * Page through repositories in one category collection, with filters, sorting
 * and pagination. Ownership of the category and the repositories is enforced
 * via the session userId.
 */
export async function listCategoryRepositories(
  query: CategoryRepositoryQuery
): Promise<CategoryRepositoriesResult> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return listCategoryRepositoriesForUser(session.user.id, query)
}

/**
 * Manually include or exclude a repository in a category collection.
 * The membership row is always written as `source="manual"` (never overwriting
 * an existing manual decision) so automatic classification cannot override it.
 */
export async function setRepositoryCategoryMembership(args: {
  repositoryId: string
  slug: string
  included: boolean
}): Promise<{ success: true }> {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return setRepositoryCategoryMembershipForUser(session.user.id, args)
}