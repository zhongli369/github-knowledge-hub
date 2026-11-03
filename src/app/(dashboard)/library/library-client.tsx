"use client"

import { useState, useMemo, useCallback, useRef, useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import Link from "next/link"
import { Star, ExternalLink, Search, X, SlidersHorizontal, Loader2, CheckCircle2, AlertTriangle, StopCircle } from "lucide-react"
import { analyzeRepositoryAction } from "@/actions/analysis"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useLanguage } from "@/i18n/LanguageProvider"
import { RepoNoteEditor } from "./repo-note-editor"
import { RepoStatusSelect } from "./repo-status-select"
import { RepoSummaryButton } from "./repo-summary-button"

// ── Types ────────────────────────────────────────────────────────

export interface LibraryItem {
  id: string
  fullName: string
  owner: string
  name: string
  description: string | null
  language: string | null
  topics: string[]
  stars: number
  forks: number
  url: string
  status: string
  note: string | null
  updatedAt: string | null
  analysisStatus: string
  summaryOneLine: string | null
  summaryProblem: string | null
  summarySimpleExplanation: string | null
  analysisCreatedAt: string | null
  analysisModel: string | null
  hasEmbedding?: boolean
  embeddingStale?: boolean
}

type SortKey = "updated" | "stars" | "name" | "summary" | "status"
type SummaryFilter = "all" | "has" | "no" | "failed"
type BatchState = "idle" | "running" | "stopping" | "completed" | "completed_with_errors"

interface FilterState {
  q: string
  status: string
  summary: SummaryFilter
  lang: string
  topic: string
  sort: SortKey
}

// ── Helpers ──────────────────────────────────────────────────────

function searchText(item: LibraryItem): string {
  return [
    item.fullName,
    item.name,
    item.description,
    item.language,
    item.topics.join(" "),
    item.note,
    item.summaryOneLine,
    item.summaryProblem,
    item.summarySimpleExplanation,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function matchesFilter(item: LibraryItem, f: FilterState): boolean {
  // Search
  if (f.q) {
    const q = f.q.toLowerCase()
    if (!searchText(item).includes(q)) return false
  }

  // Status
  if (f.status && f.status !== "all") {
    if (item.status !== f.status) return false
  }

  // Summary
  if (f.summary !== "all") {
    const s = item.analysisStatus
    if (f.summary === "has" && s !== "completed") return false
    if (f.summary === "no" && s !== "not_generated") return false
    if (f.summary === "failed" && s !== "failed") return false
  }

  // Language
  if (f.lang && f.lang !== "all") {
    if (item.language !== f.lang) return false
  }

  // Topic
  if (f.topic && f.topic !== "all") {
    if (!item.topics.includes(f.topic)) return false
  }

  return true
}

const STATUS_ORDER: Record<string, number> = {
  active: 0,
  analyzing: 1,
  new: 2,
  archived: 3,
}

function sortItems(items: LibraryItem[], sort: SortKey): LibraryItem[] {
  const sorted = [...items]
  switch (sort) {
    case "stars":
      sorted.sort((a, b) => b.stars - a.stars)
      break
    case "name":
      sorted.sort((a, b) => a.fullName.localeCompare(b.fullName))
      break
    case "summary":
      sorted.sort((a, b) => {
        const da = a.analysisCreatedAt ?? ""
        const db = b.analysisCreatedAt ?? ""
        return db.localeCompare(da)
      })
      break
    case "status":
      sorted.sort((a, b) => {
        const oa = STATUS_ORDER[a.status] ?? 99
        const ob = STATUS_ORDER[b.status] ?? 99
        return oa - ob
      })
      break
    case "updated":
    default:
      sorted.sort((a, b) => {
        const da = a.updatedAt ?? ""
        const db = b.updatedAt ?? ""
        return db.localeCompare(da)
      })
      break
  }
  return sorted
}

// ── Main Component ───────────────────────────────────────────────

export function LibraryClient({ items }: { items: LibraryItem[] }) {
  const { t } = useLanguage()
  const searchParams = useSearchParams()
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: "updated", label: t.library.sortRecent },
    { key: "stars", label: t.library.sortStars },
    { key: "name", label: t.library.sortName },
    { key: "summary", label: t.library.sortSummaryDate },
    { key: "status", label: t.library.sortStatus },
  ]

  // Init from URL
  const [filters, setFilters] = useState<FilterState>(() => ({
    q: searchParams.get("q") ?? "",
    status: searchParams.get("status") ?? "all",
    summary: (searchParams.get("summary") as SummaryFilter) ?? "all",
    lang: searchParams.get("lang") ?? "all",
    topic: searchParams.get("topic") ?? "all",
    sort: (searchParams.get("sort") as SortKey) ?? "updated",
  }))

  // Debounce URL sync
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const syncUrl = useCallback(
    (f: FilterState) => {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => {
        const params = new URLSearchParams()
        if (f.q) params.set("q", f.q)
        if (f.status !== "all") params.set("status", f.status)
        if (f.summary !== "all") params.set("summary", f.summary)
        if (f.lang !== "all") params.set("lang", f.lang)
        if (f.topic !== "all") params.set("topic", f.topic)
        if (f.sort !== "updated") params.set("sort", f.sort)
        const qs = params.toString()
        router.replace(qs ? `/library?${qs}` : "/library", { scroll: false })
      }, 300)
    },
    [router]
  )

  const update = useCallback(
    (patch: Partial<FilterState>) => {
      setFilters((prev) => {
        const next = { ...prev, ...patch }
        syncUrl(next)
        return next
      })
    },
    [syncUrl]
  )

  const clearAll = () => {
    const empty: FilterState = {
      q: "",
      status: "all",
      summary: "all",
      lang: "all",
      topic: "all",
      sort: "updated",
    }
    setFilters(empty)
    router.replace("/library", { scroll: false })
  }

  // ── Batch state ────────────────────────────────────────────────

  const [batchState, setBatchState] = useState<BatchState>("idle")
  const [batchStatuses, setBatchStatuses] = useState<Record<string, "generating" | "completed" | "failed">>({})
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, currentRepo: "" })
  const [batchResults, setBatchResults] = useState({ success: 0, failed: 0 })
  const stopRef = useRef(false)

  // Local items for optimistic updates during batch
  const [localItems, setLocalItems] = useState<LibraryItem[]>(items)
  useEffect(() => {
    if (batchState === "idle") {
      setLocalItems(items)
    }
  }, [items, batchState])

  // Filter & sort — uses localItems so batch progress is reflected immediately
  const { filtered, counts, languages, allTopics } = useMemo(() => {
    const filtered = localItems.filter((item) => matchesFilter(item, filters))
    const sorted = sortItems(filtered, filters.sort)

    const langs = [...new Set(localItems.map((i) => i.language).filter(Boolean))].sort() as string[]
    const topics = [...new Set(localItems.flatMap((i) => i.topics))].sort()

    const counts = {
      total: localItems.length,
      filtered: sorted.length,
      hasSummary: localItems.filter((i) => i.analysisStatus === "completed").length,
      noSummary: localItems.filter((i) => i.analysisStatus === "not_generated").length,
      failed: localItems.filter((i) => i.analysisStatus === "failed").length,
    }

    return { filtered: sorted, counts, languages: langs, allTopics: topics }
  }, [localItems, filters])

  // Batch-eligible repos: in current filtered view, no completed summary, not already being processed
  const batchTargets = useMemo(
    () => filtered.filter((item) => item.analysisStatus !== "completed"),
    [filtered]
  )

  const startBatch = useCallback(async () => {
    if (batchTargets.length === 0 || batchState === "running") return

    setBatchState("running")
    setBatchProgress({ current: 0, total: batchTargets.length, currentRepo: "" })
    setBatchResults({ success: 0, failed: 0 })
    setBatchStatuses({})
    stopRef.current = false

    // Pre-flight: check first item for API key issues
    const firstResult = await analyzeRepositoryAction(batchTargets[0].id)
    if (firstResult.errorCode === "API_KEY_MISSING") {
      setBatchState("completed_with_errors")
      setBatchResults({ success: 0, failed: batchTargets.length })
      return
    }

    let success = 0
    let failed = 0

    // Process first item result
    if (firstResult.summary) {
      success++
      setBatchStatuses((prev) => ({ ...prev, [batchTargets[0].id]: "completed" }))
      setLocalItems((prev) =>
        prev.map((li) =>
          li.id === batchTargets[0].id
            ? { ...li, analysisStatus: "completed", summaryOneLine: firstResult.summary?.oneLine ?? null }
            : li
        )
      )
    } else {
      failed++
      setBatchStatuses((prev) => ({ ...prev, [batchTargets[0].id]: "failed" }))
      setLocalItems((prev) =>
        prev.map((li) => (li.id === batchTargets[0].id ? { ...li, analysisStatus: "failed" } : li))
      )
    }
    setBatchResults({ success, failed })

    for (let i = 1; i < batchTargets.length; i++) {
      if (stopRef.current) break

      const item = batchTargets[i]
      setBatchProgress({ current: i + 1, total: batchTargets.length, currentRepo: item.fullName })
      setBatchStatuses((prev) => ({ ...prev, [item.id]: "generating" }))

      try {
        const result = await analyzeRepositoryAction(item.id)
        if (result.summary) {
          setBatchStatuses((prev) => ({ ...prev, [item.id]: "completed" }))
          setLocalItems((prev) =>
            prev.map((li) =>
              li.id === item.id
                ? { ...li, analysisStatus: "completed", summaryOneLine: result.summary?.oneLine ?? null }
                : li
            )
          )
          success++
        } else {
          setBatchStatuses((prev) => ({ ...prev, [item.id]: "failed" }))
          setLocalItems((prev) =>
            prev.map((li) => (li.id === item.id ? { ...li, analysisStatus: "failed" } : li))
          )
          failed++
        }
      } catch {
        setBatchStatuses((prev) => ({ ...prev, [item.id]: "failed" }))
        failed++
      }

      setBatchResults({ success, failed })
    }

    if (stopRef.current) {
      setBatchState("idle")
    } else {
      setBatchState(failed > 0 ? "completed_with_errors" : "completed")
    }
    router.refresh()
  }, [batchTargets, batchState, router])

  const stopBatch = useCallback(() => {
    stopRef.current = true
    setBatchState("stopping")
  }, [])

  // Keyboard shortcut: Ctrl+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  const hasActiveFilters =
    filters.q || filters.status !== "all" || filters.summary !== "all" || filters.lang !== "all" || filters.topic !== "all"

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={filters.q}
            onChange={(e) => update({ q: e.target.value })}
            placeholder={`${t.library.searchPlaceholder} (Ctrl+K)`}
            className="w-full rounded-md border bg-background pl-8 pr-8 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {filters.q && (
            <button
              onClick={() => update({ q: "" })}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {/* Status filter */}
        <select
          value={filters.status}
          onChange={(e) => update({ status: e.target.value })}
          className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">Status: All</option>
          <option value="new">New</option>
          <option value="analyzing">Analyzing</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>

        {/* Summary filter */}
        <select
          value={filters.summary}
          onChange={(e) => update({ summary: e.target.value as SummaryFilter })}
          className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">Summary: All</option>
          <option value="has">{t.library.withSummary}</option>
          <option value="no">{t.library.noSummary}</option>
          <option value="failed">{t.library.failed}</option>
        </select>

        {/* Language filter */}
        {languages.length > 1 && (
          <select
            value={filters.lang}
            onChange={(e) => update({ lang: e.target.value })}
            className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">Language: All</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}

        {/* Sort */}
        <select
          value={filters.sort}
          onChange={(e) => update({ sort: e.target.value as SortKey })}
          className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {t.library.sortPrefix}{opt.label}
            </option>
          ))}
        </select>

        {/* Clear filters */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="text-xs h-7"
          >
            {t.common.clearFilters}
          </Button>
        )}

        {/* Batch generate */}
        {batchState === "idle" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={startBatch}
            disabled={batchTargets.length === 0}
            className="text-xs h-7"
          >
            <Loader2 className="size-3 mr-1" />
            {batchTargets.length === 0
              ? t.library.allSummariesReady
              : `${t.library.generateMissing} (${batchTargets.length})`}
          </Button>
        ) : batchState === "completed" ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-700">
            <CheckCircle2 className="size-3" />
            {batchResults.success} {t.library.generated}, {batchResults.failed} {t.library.failed}
          </span>
        ) : batchState === "completed_with_errors" ? (
          <span className="inline-flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle className="size-3" />
            {batchResults.success} {t.library.generated}, {batchResults.failed} {t.library.failed}
          </span>
        ) : null}
      </div>

      {/* Batch progress bar */}
      {(batchState === "running" || batchState === "stopping") && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground flex-1">
            <strong className="text-foreground">{batchProgress.current}</strong> / {batchProgress.total}
            {batchProgress.currentRepo && (
              <> — <span className="text-foreground">{batchProgress.currentRepo}</span></>
            )}
          </span>
          {batchState === "running" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={stopBatch}
              className="text-xs h-6"
            >
              <StopCircle className="size-3 mr-1" />
              {t.library.stopAfterCurrent}
            </Button>
          )}
          {batchState === "stopping" && (
            <span className="text-xs text-muted-foreground">{t.library.stopping}</span>
          )}
        </div>
      )}

      {/* Topic chips */}
      {allTopics.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => update({ topic: "all" })}
            className={`text-[11px] px-1.5 py-0.5 rounded ${
              filters.topic === "all"
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {t.library.allTopics}
          </button>
          {allTopics.slice(0, 16).map((topic) => (
            <button
              key={topic}
              onClick={() => update({ topic: filters.topic === topic ? "all" : topic })}
              className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${
                filters.topic === topic
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {topic}
            </button>
          ))}
          {allTopics.length > 16 && (
            <span className="text-[11px] text-muted-foreground px-1">
              +{allTopics.length - 16} {t.library.more}
            </span>
          )}
        </div>
      )}

      {/* Stats bar */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>
          {t.library.showing} <strong className="text-foreground">{counts.filtered}</strong> {t.library.of} {counts.total}
        </span>
        <span>
          <strong className="text-foreground">{counts.hasSummary}</strong> {t.library.withSummary}
        </span>
        <span>
          <strong className="text-foreground">{counts.noSummary}</strong> {t.library.withoutSummary}
        </span>
        {counts.failed > 0 && (
          <span className="text-destructive">
            <strong>{counts.failed}</strong> {t.library.failed}
          </span>
        )}
        {hasActiveFilters && (
          <span className="text-muted-foreground">({t.common.filters.toLowerCase()})</span>
        )}
      </div>

      {/* Card list */}
      {filtered.length > 0 ? (
        <div className="grid gap-3">
          {filtered.map((item) => (
            <div key={item.id} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/library/${item.id}`}
                      className="font-medium text-sm hover:underline"
                    >
                      {item.fullName}
                    </Link>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                  {item.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {item.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {item.language && (
                      <Badge variant="secondary" className="text-xs">
                        {item.language}
                      </Badge>
                    )}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Star className="size-3" />
                      {item.stars}
                    </span>
                    {item.topics.slice(0, 4).map((topic) => (
                      <Badge key={topic} variant="outline" className="text-xs">
                        {topic}
                      </Badge>
                    ))}
                  </div>
                </div>
                <RepoStatusSelect repoId={item.id} currentStatus={item.status} />
              </div>

              <RepoNoteEditor repoId={item.id} initialNote={item.note ?? ""} />

              {/* Embedding freshness badges */}
              {item.analysisStatus === "completed" && item.hasEmbedding && item.embeddingStale && (
                <div className="flex items-center gap-1 text-[11px] text-amber-600">
                  <AlertTriangle className="size-3" />
                  {t.library.embeddingOutdated}
                </div>
              )}
              {item.analysisStatus === "completed" && !item.hasEmbedding && (
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <AlertTriangle className="size-3" />
                  {t.library.notIndexed}
                </div>
              )}

              <RepoSummaryButton
                repoId={item.id}
                initialStatus={item.analysisStatus}
                batchGenerating={batchStatuses[item.id] === "generating"}
              />
            </div>
          ))}
        </div>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <SlidersHorizontal className="size-8 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t.library.noReposMatch}
          </p>
          {hasActiveFilters && (
            <Button
              variant="outline"
              size="sm"
              onClick={clearAll}
              className="mt-3"
            >
              {t.library.clearAllFilters}
            </Button>
          )}
          {!hasActiveFilters && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t.library.goSyncFirst}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
