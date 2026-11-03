import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { DiscoverClient } from "./discover-client"

export default async function DiscoverPage() {
  const session = await auth()

  const t = await getTranslations()

  if (!session?.user?.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.discover.title}</h1>
        <p className="text-muted-foreground">
          {t.discover.description}
        </p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
        <DiscoverClient />
      </Suspense>
    </div>
  )
}
