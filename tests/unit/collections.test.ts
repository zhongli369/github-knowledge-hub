import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Collections actions; auth + prisma mocked, no real DB ──

const mocks = vi.hoisted(() => {
  const db = {
    collection: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    knowledgeAsset: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    collectionAsset: {
      createMany: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  }
  return {
    auth: vi.fn(),
    revalidatePath: vi.fn(),
    db,
  }
})

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }))

import {
  addAssetsToCollectionAction,
  addToCollectionAction,
  removeAssetsFromCollectionAction,
  removeFromCollectionAction,
  reorderCollectionAssetsAction,
  updateCollectionAction,
} from "@/actions/collections"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
  mocks.db.$transaction.mockImplementation(async (arg) =>
    Array.isArray(arg) ? await Promise.all(arg) : await arg()
  )
})

describe("updateCollectionAction", () => {
  it("renames and edits the description of an owned collection", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collection.update.mockResolvedValue({
      id: "col-1",
      name: "New Name",
      description: "New Desc",
    })

    const result = await updateCollectionAction("col-1", {
      name: "  New Name  ",
      description: "  New Desc  ",
    })

    expect(result.name).toBe("New Name")
    expect(mocks.db.collection.update).toHaveBeenCalledWith({
      where: { id: "col-1" },
      data: { name: "New Name", description: "New Desc" },
    })
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/collections")
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/collections/col-1")
  })

  it("clears a blank description instead of throwing", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collection.update.mockResolvedValue({ id: "col-1", name: "X", description: null })

    await updateCollectionAction("col-1", { name: "X", description: "   " })
    expect(mocks.db.collection.update).toHaveBeenCalledWith({
      where: { id: "col-1" },
      data: { name: "X", description: null },
    })
  })

  it("rejects a blank name before touching the database", async () => {
    await expect(updateCollectionAction("col-1", { name: "   " })).rejects.toThrow(
      "Collection name is required"
    )
    expect(mocks.db.collection.findFirst).not.toHaveBeenCalled()
  })

  it("throws when the collection is not owned", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(null)

    await expect(updateCollectionAction("col-1", { name: "X" })).rejects.toThrow(
      "Collection not found"
    )
    expect(mocks.db.collection.update).not.toHaveBeenCalled()
  })

  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue({ user: undefined })

    await expect(updateCollectionAction("col-1", { name: "X" })).rejects.toThrow(
      "Not authenticated"
    )
  })
})

describe("addAssetsToCollectionAction", () => {
  it("adds multiple owned assets in selection order with negative sortOrder", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1", name: "My Collection" })
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }])
    mocks.db.collectionAsset.createMany.mockResolvedValue({ count: 2 })

    const result = await addAssetsToCollectionAction("col-1", ["a", "b"])

    expect(result).toEqual({ added: 2, alreadyInCollection: 0, collectionName: "My Collection" })
    expect(mocks.db.collectionAsset.createMany).toHaveBeenCalledWith({
      data: [
        { collectionId: "col-1", assetId: "a", sortOrder: -2 },
        { collectionId: "col-1", assetId: "b", sortOrder: -1 },
      ],
      skipDuplicates: true,
    })
  })

  it("reports duplicates already in the collection", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1", name: "C" })
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }])
    mocks.db.collectionAsset.createMany.mockResolvedValue({ count: 1 })

    const result = await addAssetsToCollectionAction("col-1", ["a", "b"])

    expect(result).toEqual({ added: 1, alreadyInCollection: 1, collectionName: "C" })
  })

  it("throws when any requested asset is not owned (fail closed)", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1", name: "C" })
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }])

    await expect(addAssetsToCollectionAction("col-1", ["a", "b"])).rejects.toThrow(
      "Asset not found"
    )
    expect(mocks.db.collectionAsset.createMany).not.toHaveBeenCalled()
  })

  it("throws when the collection is not owned", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(null)

    await expect(addAssetsToCollectionAction("col-1", ["a"])).rejects.toThrow(
      "Collection not found"
    )
  })

  it("short-circuits an empty selection", async () => {
    const result = await addAssetsToCollectionAction("col-1", [])
    expect(result).toEqual({ added: 0, alreadyInCollection: 0, collectionName: "" })
    expect(mocks.db.collection.findFirst).not.toHaveBeenCalled()
  })
})

describe("removeAssetsFromCollectionAction", () => {
  it("removes linked assets after verifying membership and ownership", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([{ assetId: "a" }, { assetId: "b" }])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "b" }, { id: "a" }])
    mocks.db.collectionAsset.deleteMany.mockResolvedValue({ count: 2 })

    const result = await removeAssetsFromCollectionAction("col-1", ["b", "a"])

    expect(result).toEqual({ removed: 2 })
    expect(mocks.db.knowledgeAsset.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["b", "a"] }, userId: "user-1" },
      select: { id: true },
    })
    expect(mocks.db.collectionAsset.deleteMany).toHaveBeenCalledWith({
      where: { collectionId: "col-1", assetId: { in: ["b", "a"] } },
    })
  })

  it("deduplicates repeated ids", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([{ assetId: "a" }])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }])
    mocks.db.collectionAsset.deleteMany.mockResolvedValue({ count: 1 })

    const result = await removeAssetsFromCollectionAction("col-1", ["a", "a"])
    expect(result).toEqual({ removed: 1 })
  })

  it("throws when a requested asset is not linked to the collection", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([{ assetId: "a" }])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }])

    await expect(removeAssetsFromCollectionAction("col-1", ["a", "b"])).rejects.toThrow(
      "Asset not in collection"
    )
    expect(mocks.db.collectionAsset.deleteMany).not.toHaveBeenCalled()
  })

  it("throws when an asset is not owned (fail closed)", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([{ assetId: "a" }, { assetId: "evil" }])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }])

    await expect(removeAssetsFromCollectionAction("col-1", ["a", "evil"])).rejects.toThrow(
      "Asset not in collection"
    )
    expect(mocks.db.collectionAsset.deleteMany).not.toHaveBeenCalled()
  })

  it("throws when the collection is not owned", async () => {
    mocks.db.collection.findFirst.mockResolvedValue(null)

    await expect(removeAssetsFromCollectionAction("col-1", ["a"])).rejects.toThrow(
      "Collection not found"
    )
  })
})

describe("reorderCollectionAssetsAction", () => {
  it("writes 0..n-1 sortOrder for an owned, full asset set", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([
      { assetId: "a" },
      { assetId: "b" },
      { assetId: "c" },
    ])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }])
    mocks.db.collectionAsset.updateMany.mockResolvedValue({ count: 1 })

    const result = await reorderCollectionAssetsAction("col-1", ["c", "a", "b"])

    expect(result).toEqual({ success: true })
    expect(mocks.db.$transaction).toHaveBeenCalledWith(expect.any(Array))
    expect(mocks.db.collectionAsset.updateMany).toHaveBeenNthCalledWith(1, {
      where: { collectionId: "col-1", assetId: "c" },
      data: { sortOrder: 0 },
    })
    expect(mocks.db.collectionAsset.updateMany).toHaveBeenNthCalledWith(2, {
      where: { collectionId: "col-1", assetId: "a" },
      data: { sortOrder: 1 },
    })
    expect(mocks.db.collectionAsset.updateMany).toHaveBeenNthCalledWith(3, {
      where: { collectionId: "col-1", assetId: "b" },
      data: { sortOrder: 2 },
    })
  })

  it("throws when the order omits an asset already in the collection", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([
      { assetId: "a" },
      { assetId: "b" },
      { assetId: "c" },
    ])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }])

    await expect(reorderCollectionAssetsAction("col-1", ["a", "b"])).rejects.toThrow(
      "Order must include every asset in the collection"
    )
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
  })

  it("throws when the order contains an unowned or foreign asset id", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([
      { assetId: "a" },
      { assetId: "b" },
    ])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }])

    await expect(reorderCollectionAssetsAction("col-1", ["a", "evil"])).rejects.toThrow(
      "Asset not in collection"
    )
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
  })
})

describe("single-item wrappers", () => {
  it("addToCollectionAction maps added/already_in_collection status", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1", name: "C" })
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }])
    mocks.db.collectionAsset.createMany.mockResolvedValue({ count: 1 })

    expect(await addToCollectionAction("col-1", "a")).toEqual({
      status: "added",
      collectionName: "C",
    })

    mocks.db.collectionAsset.createMany.mockResolvedValue({ count: 0 })
    expect(await addToCollectionAction("col-1", "a")).toEqual({
      status: "already_in_collection",
      collectionName: "C",
    })
  })

  it("removeFromCollectionAction removes a single asset", async () => {
    mocks.db.collection.findFirst.mockResolvedValue({ id: "col-1" })
    mocks.db.collectionAsset.findMany.mockResolvedValue([{ assetId: "a" }])
    mocks.db.knowledgeAsset.findMany.mockResolvedValue([{ id: "a" }])
    mocks.db.collectionAsset.deleteMany.mockResolvedValue({ count: 1 })

    expect(await removeFromCollectionAction("col-1", "a")).toEqual({ success: true, removed: 1 })
  })
})