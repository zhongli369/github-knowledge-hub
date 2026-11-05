import { Suspense } from "react"
import { auth } from "@/auth"
import { getLocale, getTranslations } from "@/i18n/language"
import { prisma } from "@/lib/prisma"
import { listCategoryCollections } from "@/actions/collections"
import { CollectionsHomeClient } from "@/components/collections/collections-home-client"
import type { CategoryCollectionSummary } from "@/components/collections/types"

export default async function CollectionsPage() {
  const session = await auth()
  const t = await getTranslations()

  if (!session?.user?.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  const locale = await getLocale()

  const [categories, legacyCollections] = await Promise.all([
    listCategoryCollections(locale),
    prisma.collection.findMany({
      where: { userId: session.user.id, kind: "custom" },
      include: { _count: { select: { assets: true } } },
      orderBy: { updatedAt: "desc" },
    }),
  ])

  const categoryIds = new Set(categories.map((c: CategoryCollectionSummary) => c.id))
  const legacy = legacyCollections
    .filter((c) => !categoryIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      _count: { assets: c._count.assets },
      updatedAt: c.updatedAt.toISOString(),
    }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.categoryCollections.title}</h1>
        <p className="text-muted-foreground">{t.categoryCollections.description}</p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
        <CollectionsHomeClient categories={categories} legacyCollections={legacy} />
      </Suspense>
    </div>
  )
}