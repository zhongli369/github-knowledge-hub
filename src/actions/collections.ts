"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"

// ── Queries ───────────────────────────────────────────────────────

export async function getCollectionsAction() {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")
  return prisma.collection.findMany({
    where: { userId: session.user.id },
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
        orderBy: { addedAt: "desc" },
      },
    },
  })
}

// ── Mutations ─────────────────────────────────────────────────────

export async function createCollectionAction(name: string, description?: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const collection = await prisma.collection.create({
    data: { name, description, userId: session.user.id },
  })

  revalidatePath("/collections")
  return collection
}

export async function deleteCollectionAction(collectionId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: session.user.id },
    select: { id: true },
  })
  if (!collection) throw new Error("Collection not found")

  await prisma.collection.delete({ where: { id: collectionId } })
  revalidatePath("/collections")
  return { success: true }
}

export async function addToCollectionAction(collectionId: string, assetId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  // Verify ownership of both collection and asset
  const [collection, asset] = await Promise.all([
    prisma.collection.findFirst({
      where: { id: collectionId, userId: session.user.id },
      select: { id: true, name: true },
    }),
    prisma.knowledgeAsset.findFirst({
      where: { id: assetId, userId: session.user.id },
      select: { id: true },
    }),
  ])

  if (!collection) throw new Error("Collection not found")
  if (!asset) throw new Error("Asset not found")

  try {
    await prisma.collectionAsset.create({
      data: { collectionId, assetId },
    })
    revalidatePath(`/collections/${collectionId}`)
    return { status: "added", collectionName: collection.name }
  } catch (error) {
    const err = error as { code?: string }
    if (err.code === "P2002") {
      return { status: "already_in_collection", collectionName: collection.name }
    }
    throw error
  }
}

export async function removeFromCollectionAction(collectionId: string, assetId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  // Verify ownership
  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: session.user.id },
    select: { id: true },
  })
  if (!collection) throw new Error("Collection not found")

  await prisma.collectionAsset.deleteMany({
    where: { collectionId, assetId },
  })

  revalidatePath(`/collections/${collectionId}`)
  return { success: true }
}
