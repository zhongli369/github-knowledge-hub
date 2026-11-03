import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { AssetsClient } from "./assets-client"

export default async function AssetsPage() {
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
        <h1 className="text-2xl font-bold tracking-tight">{t.assets.title}</h1>
        <p className="text-muted-foreground">
          {t.assets.description}
        </p>
      </div>

      <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
        <AssetsClient />
      </Suspense>
    </div>
  )
}
