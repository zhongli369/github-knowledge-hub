"use client"

import Link from "next/link"
import {
  Github, Library, Code, Sparkles, Layers,
  CheckCircle2, AlertTriangle, Loader2, Minus,
  ArrowRight,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useLanguage } from "@/i18n/LanguageProvider"

// ── Types ────────────────────────────────────────────────────────

interface Stats {
  reposTotal: number
  reposWithSummary: number
  assetsTotal: number
  patternCount: number
  algorithmCount: number
  analysesTotal: number
  analysesThisWeek: number
  collectionsTotal: number
  collectionAssetCount: number
}

interface AssetTypeGroup { type: string; count: number }

interface RecentAnalysis {
  id: string
  analysisType: string
  status: string
  createdAt: string
  repository: { id: string; fullName: string } | null
  result: Record<string, unknown> | null
}

interface TopRepo { repoId: string; fullName: string; count: number }

interface MissingRepo { id: string; fullName: string }

// ── Helpers ──────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  algorithm: "#3b82f6", pattern: "#8b5cf6", snippet: "#6b7280",
  architecture: "#22c55e", config: "#eab308", doc: "#f97316",
}

function statusDot(status: string) {
  switch (status) {
    case "completed": return <CheckCircle2 className="size-3 text-green-600" />
    case "failed": return <AlertTriangle className="size-3 text-destructive" />
    case "running": return <Loader2 className="size-3 text-amber-500 animate-spin" />
    default: return <Minus className="size-3 text-muted-foreground" />
  }
}

// ── Section wrapper ─────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">{title}</h2>
      {children}
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────

export function DashboardClient({
  stats,
  assetTypeGroups,
  recentAnalyses,
  topRepos,
  missingAssets,
  topTags,
}: {
  stats: Stats
  assetTypeGroups: AssetTypeGroup[]
  recentAnalyses: RecentAnalysis[]
  topRepos: TopRepo[]
  missingAssets: MissingRepo[]
  topTags: [string, number][]
}) {
  const { t } = useLanguage()
  const maxTag = topTags[0]?.[1] ?? 1
  const maxAssets = topRepos[0]?.count ?? 1

  const ANALYSIS_LABELS: Record<string, string> = {
    repo_summary: t.dashboard.summary,
    asset_extraction: t.dashboard.extraction,
    code_review: t.dashboard.review,
    dependency_scan: t.dashboard.dependency,
  }

  function relativeTime(iso: string): string {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (seconds < 60) return t.dashboard.justNow
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}${t.dashboard.mAgo}`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}${t.dashboard.hAgo}`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}${t.dashboard.dAgo}`
    return new Date(iso).toLocaleDateString()
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t.dashboard.title}</h1>

      {/* ── 1. Stats Row ────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Github} label={t.dashboard.repos} value={stats.reposTotal} sub={`${stats.reposWithSummary} ${t.dashboard.reposSub}`} />
        <StatCard icon={Code} label={t.dashboard.assets} value={stats.assetsTotal} sub={`${stats.patternCount} ${t.dashboard.assetsSubPat}, ${stats.algorithmCount} ${t.dashboard.assetsSubAlg}`} />
        <StatCard icon={Sparkles} label={t.dashboard.analyses} value={stats.analysesTotal} sub={`${stats.analysesThisWeek} ${t.dashboard.analysesSub}`} />
        <StatCard icon={Layers} label={t.dashboard.collections} value={stats.collectionsTotal} sub={`${stats.collectionAssetCount} ${t.dashboard.collectionsSub}`} />
      </div>

      {/* ── Desktop grid ───────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── 2. Asset Type Breakdown ───────────────────── */}
        <Section title={t.dashboard.assetTypeBreakdown}>
          {assetTypeGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t.dashboard.noAssetsYet}
            </p>
          ) : (
            <div className="space-y-1.5">
              {assetTypeGroups
                .sort((a, b) => b.count - a.count)
                .map((g) => {
                  const pct = stats.assetsTotal > 0 ? (g.count / stats.assetsTotal) * 100 : 0
                  return (
                    <div key={g.type} className="flex items-center gap-2 text-xs">
                      <span className="w-20 capitalize">{g.type}</span>
                      <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, backgroundColor: TYPE_COLORS[g.type] ?? "#6b7280" }}
                        />
                      </div>
                      <span className="w-14 text-right text-muted-foreground">{pct.toFixed(0)}%</span>
                      <span className="w-8 text-right text-muted-foreground">({g.count})</span>
                    </div>
                  )
                })}
            </div>
          )}
        </Section>

        {/* ── 3. Recent Activity ──────────────────────────── */}
        <Section title={t.dashboard.recentActivity}>
          {recentAnalyses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t.dashboard.noActivity}
            </p>
          ) : (
            <div className="space-y-2">
              {recentAnalyses.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs">
                  {statusDot(a.status)}
                  <span className="w-16 text-muted-foreground shrink-0">{relativeTime(a.createdAt)}</span>
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {ANALYSIS_LABELS[a.analysisType] ?? a.analysisType}
                  </Badge>
                  <span className="w-16 text-muted-foreground shrink-0">{a.status}</span>
                  {a.repository ? (
                    <Link href={`/library/${a.repository.id}`} className="text-foreground hover:underline truncate">
                      {a.repository.fullName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {a.result && (a.result as { extracted?: number }).extracted != null && (
                    <span className="text-muted-foreground shrink-0">
                      ({(a.result as { extracted: number }).extracted} {t.dashboard.extracted})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── 4. Knowledge Coverage ───────────────────────── */}
        <Section title={t.dashboard.knowledgeCoverage}>
          {topRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t.dashboard.noCoverageData}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t.dashboard.topReposByAssets}</p>
              {topRepos.map((r, i) => (
                <div key={r.repoId} className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-muted-foreground">{i + 1}.</span>
                  <Link href={`/library/${r.repoId}`} className="font-medium hover:underline flex-1 truncate">
                    {r.fullName}
                  </Link>
                  <span className="text-muted-foreground shrink-0">{r.count} {t.dashboard.assets}</span>
                  <div className="w-20 h-3 bg-muted rounded-full overflow-hidden shrink-0">
                    <div
                      className="h-full bg-primary/40 rounded-full"
                      style={{ width: `${(r.count / maxAssets) * 100}%` }}
                    />
                  </div>
                </div>
              ))}

              {missingAssets.length > 0 && (
                <>
                  <div className="border-t pt-2 mt-2" />
                  <p className="text-xs text-muted-foreground">
                    {t.dashboard.reposWithSummaryNoAssets}: {missingAssets.length}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {missingAssets.slice(0, 5).map((r) => r.fullName).join(", ")}
                    {missingAssets.length > 5 && ` +${missingAssets.length - 5} ${t.library.more}`}
                  </p>
                </>
              )}
            </div>
          )}
        </Section>

        {/* ── 5. Top Tags ─────────────────────────────────── */}
        <Section title={t.dashboard.topTags}>
          {topTags.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t.dashboard.tagsEmptyHint}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {topTags.map(([tag, count]) => {
                const ratio = count / maxTag
                return (
                  <Badge
                    key={tag}
                    variant="secondary"
                    style={{
                      fontSize: `${0.65 + ratio * 0.45}rem`,
                      opacity: 0.45 + ratio * 0.55,
                    }}
                  >
                    {tag}
                  </Badge>
                )
              })}
            </div>
          )}
        </Section>
      </div>

      {/* ── 6. Quick Actions ──────────────────────────────── */}
      <Section title={t.dashboard.quickActions}>
        <div className="flex flex-wrap gap-2">
          <ActionLink href="/repos" icon={Github} label={t.dashboard.syncRepos} />
          <ActionLink href="/library" icon={Library} label={t.dashboard.browseLibrary} />
          <ActionLink href="/assets" icon={Code} label={t.dashboard.searchAssets} />
          <ActionLink href="/collections" icon={Layers} label={t.dashboard.newCollection} />
        </div>
      </Section>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number
  sub: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="size-4" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold">{value.toLocaleString()}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}

function ActionLink({ href, icon: Icon, label }: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
    >
      <Icon className="size-4" />
      {label}
      <ArrowRight className="size-3.5 ml-0.5" />
    </Link>
  )
}
