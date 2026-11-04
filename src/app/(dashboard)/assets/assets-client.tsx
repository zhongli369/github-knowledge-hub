"use client"

import { useState, useCallback, useTransition, useEffect } from "react"
import Link from "next/link"
import { Search, Loader2, Code, SlidersHorizontal, X, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useLanguage } from "@/i18n/LanguageProvider"
import { searchAssetsPageAction, getAssetFilterOptions } from "@/actions/knowledge"
import type { AssetSearchFilters, AssetSearchPageResult, AssetSortKey } from "@/services/llm/embeddings.service"

const TYPE_COLORS: Record<string, string> = {
  algorithm: "bg-blue-100 text-blue-800",
  pattern: "bg-purple-100 text-purple-800",
  snippet: "bg-gray-100 text-gray-800",
  architecture: "bg-green-100 text-green-800",
  config: "bg-yellow-100 text-yellow-800",
  doc: "bg-orange-100 text-orange-800",
}

const ASSET_TYPES = ["algorithm", "pattern", "snippet", "architecture", "config", "doc"]
const PAGE_SIZE = 12

export function AssetsClient() {
  const { t } = useLanguage()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<AssetSearchPageResult | null>(null)
  const [isPending, startTransition] = useTransition()

  // Sorting & pagination
  const [sort, setSort] = useState<AssetSortKey>("relevance")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  // Error state
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  // Filters
  const [showFilters, setShowFilters] = useState(false)
  const [assetTypeFilter, setAssetTypeFilter] = useState("all")
  const [langFilter, setLangFilter] = useState("all")
  const [difficultyFilter, setDifficultyFilter] = useState("all")
  const [tagInput, setTagInput] = useState("")
  const [languages, setLanguages] = useState<string[]>([])
  const [difficulties, setDifficulties] = useState<string[]>([])

  useEffect(() => {
    getAssetFilterOptions().then((opts) => {
      setLanguages(opts.languages)
      setDifficulties(opts.difficulties)
    })
  }, [])

  const activeFilterCount =
    (assetTypeFilter !== "all" ? 1 : 0) +
    (langFilter !== "all" ? 1 : 0) +
    (difficultyFilter !== "all" ? 1 : 0) +
    (tagInput.trim() ? 1 : 0)

  const clearFilters = () => {
    setAssetTypeFilter("all")
    setLangFilter("all")
    setDifficultyFilter("all")
    setTagInput("")
  }

  const buildFilters = useCallback((): AssetSearchFilters => {
    const filters: AssetSearchFilters = {}
    if (assetTypeFilter !== "all") filters.assetType = assetTypeFilter
    if (langFilter !== "all") filters.language = langFilter
    if (difficultyFilter !== "all") filters.difficulty = difficultyFilter
    const tags = tagInput
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
    if (tags.length > 0) filters.tags = tags
    return filters
  }, [assetTypeFilter, langFilter, difficultyFilter, tagInput])

  const executeSearch = useCallback(
    (target: { page?: number; sort?: AssetSortKey } = {}) => {
      const q = query.trim()
      if (!q) return

      const nextSort = target.sort ?? sort

      setError(null)
      setErrorCode(null)
      startTransition(async () => {
        const nextPage = target.page ?? 1
        try {
          const result = await searchAssetsPageAction(q, {
            page: nextPage,
            pageSize: PAGE_SIZE,
            sort: nextSort,
            filters: buildFilters(),
          })
          if (!result.ok) {
            setError(result.error)
            setErrorCode(result.errorCode)
            setResults({ items: [], total: 0, page: nextPage, pageSize: PAGE_SIZE, hasMore: false })
            setTotal(0)
            setPage(nextPage)
            return
          }
          setResults(result.data!)
          setTotal(result.data!.total)
          setPage(result.data!.page)
        } catch {
          setError("Search failed")
          setErrorCode("SEARCH_FAILED")
          setResults({ items: [], total: 0, page: nextPage, pageSize: PAGE_SIZE, hasMore: false })
          setTotal(0)
          setPage(nextPage)
        }
      })
    },
    [query, sort, buildFilters]
  )

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (!query.trim() || isPending) return
      executeSearch({})
    },
    [query, isPending, executeSearch]
  )

  // Asset type display labels from translations
  const ASSET_TYPE_LABELS: Record<string, string> = {
    algorithm: t.assets.algorithm,
    pattern: t.assets.pattern,
    snippet: t.assets.snippet,
    architecture: t.assets.architecture,
    config: t.assets.config,
    doc: t.assets.doc,
  }

  const hasMore = results !== null && page * PAGE_SIZE < total
  const currentErrorText =
    errorCode === "EMBEDDING_UNAVAILABLE"
      ? t.common.embeddingUnavailable
      : error
        ? t.common.searchError
        : null

  return (
    <div className="space-y-4">
      {/* Search form */}
      <form onSubmit={handleSearch} className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[240px] max-w-[480px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.assets.searchPlaceholder}
            className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="submit"
          disabled={!query.trim() || isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          {t.assets.searchButton}
          {activeFilterCount > 0 && (
            <span className="ml-1 rounded-full bg-background/20 px-1.5 text-[11px]">{activeFilterCount}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowFilters((p) => !p)}
          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-2 text-xs transition-colors ${
            showFilters || activeFilterCount > 0
              ? "border-foreground text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <SlidersHorizontal className="size-3.5" />
          {t.common.filters}
          {activeFilterCount > 0 && ` (${activeFilterCount})`}
        </button>

        {/* Sort */}
        <select
          value={sort}
          onChange={(e) => {
            const next = e.target.value as AssetSortKey
            setSort(next)
            if (query.trim() && !isPending) executeSearch({ sort: next })
          }}
          className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="relevance">{t.common.sortRelevance}</option>
          <option value="title">{t.assets.sortTitle}</option>
          <option value="updated">{t.assets.sortUpdated}</option>
        </select>
      </form>

      {/* Filter row */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
          <select
            value={assetTypeFilter}
            onChange={(e) => setAssetTypeFilter(e.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">{t.assets.typeAll}</option>
            {ASSET_TYPES.map((type) => (
              <option key={type} value={type}>{ASSET_TYPE_LABELS[type] ?? type}</option>
            ))}
          </select>

          {languages.length > 0 && (
            <select
              value={langFilter}
              onChange={(e) => setLangFilter(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t.assets.languageAll}</option>
              {languages.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          )}

          {difficulties.length > 0 && (
            <select
              value={difficultyFilter}
              onChange={(e) => setDifficultyFilter(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t.assets.diffAll}</option>
              {difficulties.map((d) => (
                <option key={d} value={d}>{t.assets[d as keyof typeof t.assets] ?? d}</option>
              ))}
            </select>
          )}

          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            placeholder={t.assets.tags}
            className="w-44 rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="size-3" />
              {t.common.clearFilters}
            </button>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && currentErrorText && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="size-3.5 shrink-0" />
            {currentErrorText}
          </span>
          <button
            type="button"
            onClick={() => executeSearch({})}
            className="shrink-0 rounded border border-destructive/30 px-2 py-0.5 hover:bg-destructive/10 transition-colors"
          >
            {t.common.retry}
          </button>
        </div>
      )}

      {/* Loading */}
      {isPending && results == null && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="size-4 animate-spin" />
          {t.assets.searching}
        </div>
      )}

      {/* Empty state */}
      {results == null && !isPending && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Code className="size-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t.assets.emptyState}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.assets.emptyHint}
          </p>
        </div>
      )}

      {/* No results */}
      {results !== null && results.total === 0 && !isPending && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {t.assets.noResults}
          </p>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.common.clearFilters}
            </button>
          )}
        </div>
      )}

      {/* Results */}
      {results !== null && results.total > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t.assets.found} <strong className="text-foreground">{total}</strong> {t.assets.matchingAssets}
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {results.items.map((r) => (
              <div key={r.assetId} className="rounded-lg border p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/assets/${r.assetId}`}
                      className="text-sm font-medium hover:underline truncate block"
                    >
                      {r.title}
                    </Link>
                    <Link
                      href={`/library/${r.repositoryId}`}
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      {t.assets.from} {r.repoFullName}
                    </Link>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                    {(r.similarity * 100).toFixed(0)}%
                  </span>
                </div>

                {r.summary && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{r.summary}</p>
                )}

                <div className="flex flex-wrap items-center gap-1">
                  <Badge className={`text-[10px] ${TYPE_COLORS[r.assetType] ?? ""}`}>
                    {r.assetType}
                  </Badge>
                  {r.language && (
                    <Badge variant="secondary" className="text-[10px]">{r.language}</Badge>
                  )}
                  {r.difficulty && (
                    <Badge variant="outline" className="text-[10px]">{t.assets[r.difficulty as keyof typeof t.assets] ?? r.difficulty}</Badge>
                  )}
                  {r.tags.slice(0, 3).map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => executeSearch({ page: page - 1 })}
                disabled={page <= 1 || isPending}
                className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
              >
                <ChevronLeft className="size-3.5" />
                {t.common.prevPage}
              </button>
              <span className="text-xs text-muted-foreground">
                {t.common.pageIndicator.replace("%d", String(page))}
              </span>
              <button
                type="button"
                onClick={() => executeSearch({ page: page + 1 })}
                disabled={!hasMore || isPending}
                className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40"
              >
                {t.common.nextPage}
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}