import { Suspense } from "react"
import { Star, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { getMyRepos } from "@/actions/repos"
import { getTranslations } from "@/i18n/language"
import { SyncButton } from "./sync-button"

async function RepoList() {
  const repos = await getMyRepos()
  const t = await getTranslations()

  if (repos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.repos.noRepos}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t.common.pleaseLogin}
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {repos.map((repo) => (
        <div
          key={repo.id}
          className="flex items-start justify-between rounded-lg border p-4"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <a
                href={repo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                {repo.fullName}
              </a>
              <ExternalLink className="size-3 text-muted-foreground" />
            </div>
            {repo.description && (
              <p className="text-sm text-muted-foreground line-clamp-2">
                {repo.description}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {repo.language && (
                <Badge variant="secondary" className="text-xs">
                  {repo.language}
                </Badge>
              )}
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Star className="size-3" />
                {repo.stars}
              </span>
              {repo.topics.slice(0, 4).map((topic) => (
                <Badge key={topic} variant="outline" className="text-xs">
                  {topic}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default async function ReposPage() {
  const t = await getTranslations()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.repos.title}</h1>
          <p className="text-muted-foreground">{t.library.goSyncFirst}</p>
        </div>
        <div className="flex gap-2">
          <SyncButton action="my" />
          <SyncButton action="starred" />
        </div>
      </div>

      <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
        <RepoList />
      </Suspense>
    </div>
  )
}
