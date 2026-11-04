import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { getTranslations } from "@/i18n/language"
import { DashboardClient } from "./dashboard-client"

export default async function DashboardPage() {
  const session = await auth()
  const userId = session?.user?.id

  const t = await getTranslations()

  if (!userId) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [
    reposTotal,
    reposWithSummary,
    assetsTotal,
    patternCount,
    algorithmCount,
    analysesTotal,
    analysesThisWeek,
    collectionsTotal,
    collectionAssetCount,
    assetTypeGroups,
    recentAnalyses,
    topReposByAssets,
    reposWithSummariesList,
    allAssetTags,
  ] = await Promise.all([
    // Stats
    prisma.repository.count({ where: { userId } }),
    prisma.repository.count({
      where: { userId, analyses: { some: { analysisType: "repo_summary", status: "completed" } } },
    }),
    prisma.knowledgeAsset.count({ where: { userId } }),
    prisma.knowledgeAsset.count({ where: { userId, assetType: "pattern" } }),
    prisma.knowledgeAsset.count({ where: { userId, assetType: "algorithm" } }),
    prisma.analysis.count({ where: { userId } }),
    prisma.analysis.count({ where: { userId, createdAt: { gte: weekAgo } } }),
    prisma.collection.count({ where: { userId } }),
    prisma.collectionAsset.count({ where: { collection: { userId } } }),

    // Asset type breakdown
    prisma.knowledgeAsset.groupBy({
      by: ["assetType"],
      where: { userId },
      _count: true,
    }),

    // Recent activity
    prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { repository: { select: { id: true, fullName: true } } },
    }),

    // Top repos by asset count
    prisma.knowledgeAsset.groupBy({
      by: ["repositoryId"],
      where: { userId },
      _count: true,
      orderBy: { _count: { id: "desc" } },
      take: 5,
    }),

    // Repos with summaries (for coverage gap)
    prisma.repository.findMany({
      where: { userId, analyses: { some: { analysisType: "repo_summary", status: "completed" } } },
      select: { id: true, fullName: true },
    }),

    // All tags
    prisma.knowledgeAsset.findMany({
      where: { userId },
      select: { tags: true },
    }),
  ])

  // Resolve top repo names
  const repoIds = topReposByAssets.map((r) => r.repositoryId)
  const repoMap = new Map<string, string>()
  if (repoIds.length > 0) {
    const repos = await prisma.repository.findMany({
      where: { id: { in: repoIds }, userId },
      select: { id: true, fullName: true },
    })
    for (const r of repos) repoMap.set(r.id, r.fullName)
  }

  // Coverage gap: repos with summaries but no assets
  const reposWithAssets = await prisma.knowledgeAsset.groupBy({
    by: ["repositoryId"],
    where: { userId },
  })
  const repoIdsWithAssets = new Set(reposWithAssets.map((r) => r.repositoryId))
  const missingAssets = reposWithSummariesList.filter((r) => !repoIdsWithAssets.has(r.id))

  // Tag frequencies
  const tagFreq = new Map<string, number>()
  for (const a of allAssetTags) {
    for (const t of a.tags) {
      tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1)
    }
  }
  const topTags = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)

  return (
    <DashboardClient
      stats={{
        reposTotal,
        reposWithSummary,
        assetsTotal,
        patternCount,
        algorithmCount,
        analysesTotal,
        analysesThisWeek,
        collectionsTotal,
        collectionAssetCount,
      }}
      assetTypeGroups={assetTypeGroups.map((g) => ({ type: g.assetType, count: g._count }))}
      recentAnalyses={recentAnalyses.map((a) => ({
        id: a.id,
        analysisType: a.analysisType,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        repository: a.repository ? { id: a.repository.id, fullName: a.repository.fullName } : null,
        result: a.result as Record<string, unknown> | null,
      }))}
      topRepos={topReposByAssets.map((r) => ({
        repoId: r.repositoryId,
        fullName: repoMap.get(r.repositoryId) ?? "Unknown",
        count: r._count,
      }))}
      missingAssets={missingAssets.map((r) => ({ id: r.id, fullName: r.fullName }))}
      topTags={topTags}
    />
  )
}
