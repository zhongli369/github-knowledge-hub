import { notFound } from "next/navigation"
import Link from "next/link"
import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { ArrowLeft } from "lucide-react"
import { CollectionDetailClient } from "./collection-detail-client"

export default async function CollectionDetailPage({
  params,
}: {
  params: Promise<{ collectionId: string }>
}) {
  const { collectionId } = await params
  const session = await auth()

  const t = await getTranslations()

  if (!session?.user?.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  const { prisma } = await import("@/lib/prisma")
  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: session.user.id },
    include: {
      assets: {
        include: { asset: true },
        orderBy: [{ sortOrder: "asc" }, { addedAt: "desc" }],
      },
    },
  })

  if (!collection) notFound()

  return (
    <div className="space-y-6">
      <Link
        href="/collections"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        {t.common.backToCollections}
      </Link>

      <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
        <CollectionDetailClient
          collectionId={collection.id}
          initialName={collection.name}
          initialDescription={collection.description}
          initialAssets={collection.assets.map((ca) => ({
            ...ca.asset,
            addedAt: ca.addedAt.toISOString(),
          }))}
        />
      </Suspense>
    </div>
  )
}
