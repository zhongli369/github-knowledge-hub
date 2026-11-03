"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { syncMyRepos, syncStarredRepos } from "@/actions/repos"
import { useLanguage } from "@/i18n/LanguageProvider"

interface SyncButtonProps {
  action: "my" | "starred"
}

export function SyncButton({ action }: SyncButtonProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const { t } = useLanguage()

  const label = action === "my" ? t.repos.syncMyRepos : t.repos.syncStarred
  const fn = action === "my" ? syncMyRepos : syncStarredRepos

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await fn()
          router.refresh()
        })
      }}
    >
      <RefreshCw
        className={`mr-2 size-4 ${isPending ? "animate-spin" : ""}`}
      />
      {isPending ? t.repos.syncing : label}
    </Button>
  )
}
