import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { prisma } from "@/lib/prisma"
import { CollectionsClient } from "./collections-client"

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

  const collections = await prisma.collection.findMany({
    where: { userId: session.user.id },
    include: { _count: { select: { assets: true } } },
    orderBy: { updatedAt: "desc" },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.collections.title}</h1>
        <p className="text-muted-foreground">
          {t.collections.description}
        </p>
      </div>

      {collections.length === 0 ? (
        <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
          <CollectionsClient collections={[]} isEmpty />
        </Suspense>
      ) : (
        <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
          <CollectionsClient collections={collections.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            _count: { assets: c._count.assets },
            updatedAt: c.updatedAt.toISOString(),
          }))} />
        </Suspense>
      )}
    </div>
  )
}
