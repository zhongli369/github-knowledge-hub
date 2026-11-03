"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { CheckCircle2, AlertTriangle, Clock, Loader2, Cpu, Hash } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useLanguage } from "@/i18n/LanguageProvider"
interface AnalysisWithRepo {
  id: string
  analysisType: string
  status: string
  result: unknown
  error: string | null
  model: string | null
  tokensUsed: number | null
  durationMs: number | null
  repositoryId: string | null
  createdAt: Date
  repository: { id: string; fullName: string } | null
}

function statusBadge(status: string) {
  switch (status) {
    case "completed":
      return <Badge className="text-xs bg-green-100 text-green-800">Completed</Badge>
    case "failed":
      return <Badge variant="destructive" className="text-xs">Failed</Badge>
    case "pending":
      return <Badge className="text-xs bg-yellow-100 text-yellow-800">Pending</Badge>
    case "running":
      return <Badge className="text-xs bg-blue-100 text-blue-800">Running</Badge>
    default:
      return <Badge variant="outline" className="text-xs">{status}</Badge>
  }
}

function statusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-3.5 text-green-600" />
    case "failed":
      return <AlertTriangle className="size-3.5 text-destructive" />
    case "pending":
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
    default:
      return null
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function AnalysesClient({ analyses }: { analyses: AnalysisWithRepo[] }) {
  const { t } = useLanguage()
  const [typeFilter, setTypeFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")

  const TYPE_LABELS: Record<string, string> = {
    repo_summary: t.analyses.repoSummary,
    code_review: t.analyses.codeReview,
    dependency_scan: t.analyses.dependencyScan,
  }

  const types = useMemo(
    () => [...new Set(analyses.map((a) => a.analysisType))].sort(),
    [analyses]
  )

  const filtered = useMemo(() => {
    return analyses.filter((a) => {
      if (typeFilter !== "all" && a.analysisType !== typeFilter) return false
      if (statusFilter !== "all" && a.status !== statusFilter) return false
      return true
    })
  }, [analyses, typeFilter, statusFilter])

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">{t.analyses.allTypes}</option>
          {types.map((typ) => (
            <option key={typ} value={typ}>
              {TYPE_LABELS[typ] ?? typ}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">{t.analyses.allStatus}</option>
          <option value="completed">{t.analyses.completed}</option>
          <option value="failed">{t.analyses.failed}</option>
          <option value="pending">{t.analyses.pending}</option>
          <option value="running">{t.analyses.running}</option>
        </select>

        <span className="text-[11px] text-muted-foreground">
          {t.library.showing} <strong className="text-foreground">{filtered.length}</strong> {t.library.of} {analyses.length}
        </span>
      </div>

      {/* Card list */}
      {filtered.length > 0 ? (
        <div className="grid gap-3">
          {filtered.map((a) => (
            <div key={a.id} className="rounded-lg border p-4 space-y-2">
              {/* Top row: type + status */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {statusIcon(a.status)}
                  <span className="text-sm font-medium">
                    {TYPE_LABELS[a.analysisType] ?? a.analysisType}
                  </span>
                  {statusBadge(a.status)}
                </div>
              </div>

              {/* Repo link */}
              {a.repository && (
                <Link
                  href={`/library/${a.repository.id}`}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {a.repository.fullName}
                </Link>
              )}

              {/* Metadata row */}
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                {a.model && (
                  <span className="flex items-center gap-1">
                    <Cpu className="size-3" />
                    {a.model}
                  </span>
                )}
                {a.tokensUsed != null && (
                  <span className="flex items-center gap-1">
                    <Hash className="size-3" />
                    {a.tokensUsed.toLocaleString()} {t.analyses.tokens}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Clock className="size-3" />
                  {formatDuration(a.durationMs)}
                </span>
                <span>
                  {a.createdAt.toLocaleDateString("zh-CN", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>

              {/* Error */}
              {a.status === "failed" && a.error && (
                <p className="text-xs text-muted-foreground bg-destructive/5 rounded-md px-2 py-1">
                  {a.error}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {t.analyses.noAnalysesMatch}
          </p>
          {(typeFilter !== "all" || statusFilter !== "all") && (
            <button
              onClick={() => { setTypeFilter("all"); setStatusFilter("all") }}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.common.clearFilters}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
