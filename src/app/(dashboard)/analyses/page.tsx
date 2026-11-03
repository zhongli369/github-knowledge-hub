import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { getUserAnalyses } from "@/services/llm"
import { AnalysesClient } from "./analyses-client"

export default async function AnalysesPage() {
  const session = await auth()

  const t = await getTranslations()

  if (!session?.user?.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  const analyses = await getUserAnalyses(session.user.id)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.analyses.title}</h1>
        <p className="text-muted-foreground">
          {t.analyses.description}
        </p>
      </div>

      {analyses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-muted-foreground">{t.analyses.noAnalyses}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.analyses.goGenerateFirst}
          </p>
        </div>
      ) : (
        <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
          <AnalysesClient analyses={analyses} />
        </Suspense>
      )}
    </div>
  )
}
