import { notFound } from "next/navigation"
import Link from "next/link"
import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { prisma } from "@/lib/prisma"
import { getRepoAnalysisStatus } from "@/services/llm"
import { checkEmbeddingFreshness } from "@/services/llm/repo-embedding.service"
import { ArrowLeft, ExternalLink, Star, GitFork, Clock, AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { RepoStatusSelect } from "../repo-status-select"
import { RepoNoteEditor } from "../repo-note-editor"
import { RepoSummaryButton } from "../repo-summary-button"
import { SimilarRepos } from "./similar-repos"
import { AssetsClient } from "./assets-client"

interface Props {
  params: Promise<{ repoId: string }>
}

export default async function RepoDetailPage({ params }: Props) {
  const { repoId } = await params

  const session = await auth()
  if (!session?.user?.id) {
    const t = await getTranslations()
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  const t = await getTranslations()

  const repo = await prisma.repository.findFirst({
    where: { id: repoId, userId: session.user.id },
  })

  if (!repo) {
    notFound()
  }

  const analysisMeta = await getRepoAnalysisStatus(repoId, session.user.id)
  const freshness = analysisMeta.status === "completed"
    ? await checkEmbeddingFreshness(repoId, session.user.id)
    : null

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/library"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        {t.common.backToLibrary}
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold truncate">{repo.fullName}</h1>
              <a
                href={repo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <ExternalLink className="size-4" />
              </a>
            </div>
            {repo.description && (
              <p className="text-sm text-muted-foreground">{repo.description}</p>
            )}
          </div>
          <RepoStatusSelect repoId={repo.id} currentStatus={repo.status} />
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {repo.language && (
            <Badge variant="secondary" className="text-xs">
              {repo.language}
            </Badge>
          )}
          <span className="flex items-center gap-1">
            <Star className="size-3.5" />
            {repo.stars}
          </span>
          <span className="flex items-center gap-1">
            <GitFork className="size-3.5" />
            {repo.forks}
          </span>
          {repo.pushedAt && (
            <span className="flex items-center gap-1">
              <Clock className="size-3.5" />
              {new Date(repo.pushedAt).toLocaleDateString("zh-CN", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          )}
        </div>

        {/* Topics */}
        {repo.topics.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {repo.topics.map((t) => (
              <Badge key={t} variant="outline" className="text-xs">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Divider */}
      <hr className="border-border" />

      {/* Note section */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t.library.notes}
        </h2>
        <RepoNoteEditor repoId={repo.id} initialNote={repo.note ?? ""} />
      </section>

      {/* Divider */}
      <hr className="border-border" />

      {/* Summary section */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t.library.aiSummary}
        </h2>
        {freshness && freshness.hasEmbedding && freshness.isStale && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="size-3.5 shrink-0" />
            {t.library.embeddingStaleBanner}
          </div>
        )}
        {freshness && !freshness.hasEmbedding && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 border px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="size-3.5 shrink-0" />
            {t.library.notIndexedBanner}
          </div>
        )}
        <RepoSummaryButton
          repoId={repo.id}
          initialStatus={analysisMeta?.status ?? "not_generated"}
        />
      </section>

      {/* Similar Repos — only when summary exists */}
      {analysisMeta?.status === "completed" && (
        <>
          <hr className="border-border" />
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              {t.library.similarRepos}
            </h2>
            <Suspense
              fallback={
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="rounded-lg border p-3 animate-pulse">
                      <div className="h-4 bg-muted rounded w-3/4" />
                      <div className="h-3 bg-muted rounded w-1/2 mt-2" />
                    </div>
                  ))}
                </div>
              }
            >
              <SimilarRepos repoId={repo.id} />
            </Suspense>
          </section>
        </>
      )}

      {/* Knowledge Assets */}
      <hr className="border-border" />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t.library.knowledgeAssets}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t.library.assetsDescription}
        </p>
        <Suspense
          fallback={
            <div className="grid gap-2 md:grid-cols-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border p-3 animate-pulse">
                  <div className="h-4 bg-muted rounded w-3/4" />
                  <div className="h-3 bg-muted rounded w-1/2 mt-2" />
                </div>
              ))}
            </div>
          }
        >
          <AssetsClient repoId={repo.id} />
        </Suspense>
      </section>
    </div>
  )
}
