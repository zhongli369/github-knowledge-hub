import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { getAutomationDashboardAction } from "@/actions/automation"
import { AutomationClient } from "./automation-client"

export default async function AutomationPage() {
  const session = await auth()
  const t = await getTranslations()

  if (!session?.user?.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  const initial = await getAutomationDashboardAction()

  return (
    <div className="space-y-6">
      <Suspense
        fallback={<p className="text-muted-foreground">{t.common.loading}</p>}
      >
        <AutomationClient initial={initial} />
      </Suspense>
    </div>
  )
}