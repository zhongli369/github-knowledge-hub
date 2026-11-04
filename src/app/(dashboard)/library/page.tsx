import { Suspense } from "react"
import { getMyRepos } from "@/actions/repos"
import { prisma } from "@/lib/prisma"
import { getTranslations } from "@/i18n/language"
import { checkEmbeddingFreshnessBatch } from "@/services/llm/repo-embedding.service"
import { LibraryClient, type LibraryItem } from "./library-client"

async function getLibraryItems(): Promise<LibraryItem[]> {
  const repos = await getMyRepos()

  if (repos.length === 0) return []

  const repoIds = repos.map((r) => r.id)
  const viewerId = repos[0]?.userId ?? ""
  const [analyses, freshnessMap] = await Promise.all([
    // The repositoryId set is already the viewer's own repos, but the Analysis
    // query is additionally scoped by userId so a stray Analysis row created
    // with the viewer's repositoryId but another user's userId can never leak
    // into (or shadow) the viewer's Library status.
    prisma.analysis.findMany({
      where: {
        repositoryId: { in: repoIds },
        userId: viewerId,
        analysisType: "repo_summary",
      },
      select: {
        repositoryId: true,
        status: true,
        createdAt: true,
        model: true,
        result: true,
      },
      distinct: ["repositoryId"],
      orderBy: { createdAt: "desc" },
    }),
    // Batch freshness — timestamp comparison only, no textHash rebuild
    checkEmbeddingFreshnessBatch(repoIds, viewerId),
  ])
  const analysisMap = new Map(analyses.map((a) => [a.repositoryId!, a]))

  return repos.map((repo) => {
    const analysis = analysisMap.get(repo.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = analysis?.result as Record<string, any> | null
    const summary = result?.summary ?? null
    const freshness = freshnessMap.get(repo.id)

    return {
      id: repo.id,
      fullName: repo.fullName,
      owner: repo.owner,
      name: repo.name,
      description: repo.description,
      language: repo.language,
      topics: repo.topics,
      stars: repo.stars,
      forks: repo.forks,
      url: repo.url,
      status: repo.status,
      note: repo.note,
      updatedAt: repo.pushedAt?.toISOString() ?? repo.lastFetchedAt.toISOString(),
      analysisStatus: analysis?.status ?? "not_generated",
      summaryOneLine: summary?.oneLine ?? null,
      summaryProblem: summary?.problem ?? null,
      summarySimpleExplanation: summary?.simpleExplanation ?? null,
      analysisCreatedAt: analysis?.createdAt?.toISOString() ?? null,
      analysisModel: analysis?.model ?? null,
      hasEmbedding: freshness?.hasEmbedding ?? false,
      embeddingStale: freshness?.isStale ?? false,
    }
  })
}

export default async function LibraryPage() {
  const items = await getLibraryItems()
  const t = await getTranslations()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t.library.title}
        </h1>
        <p className="text-muted-foreground">
          {t.library.description}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-muted-foreground">
            {t.library.noRepos}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.library.goSyncFirst}
          </p>
        </div>
      ) : (
        <Suspense fallback={<p className="text-muted-foreground">{t.common.loading}</p>}>
          <LibraryClient items={items} />
        </Suspense>
      )}
    </div>
  )
}
