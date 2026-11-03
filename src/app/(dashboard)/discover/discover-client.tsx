"use client"

import { useState, useCallback, useTransition, useEffect } from "react"
import Link from "next/link"
import { Search, Loader2, Star, ExternalLink, SlidersHorizontal, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useLanguage } from "@/i18n/LanguageProvider"
import { searchReposAction, getFilterOptions } from "@/actions/discover"
import type { SearchResult, SearchFilters, SearchMode } from "@/services/llm/repo-embedding.service"

const STAR_PRESETS = [0, 10, 100, 1000]

export function DiscoverClient() {
  const { t } = useLanguage()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [isPending, startTransition] = useTransition()

  // Search mode
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid")

  // Filter state
  const [showFilters, setShowFilters] = useState(false)
  const [languageFilter, setLanguageFilter] = useState("all")
  const [minStars, setMinStars] = useState(0)
  const [topicInput, setTopicInput] = useState("")
  const [languages, setLanguages] = useState<string[]>([])

  // Load filter options on mount
  useEffect(() => {
    getFilterOptions().then((opts) => setLanguages(opts.languages))
  }, [])

  const activeFilterCount =
    (languageFilter !== "all" ? 1 : 0) +
    (minStars > 0 ? 1 : 0) +
    (topicInput.trim() ? 1 : 0)

  const switchMode = useCallback(
    (mode: SearchMode) => {
      if (mode === searchMode) return
      setSearchMode(mode)
      // Auto-re-trigger search if there's an active query
      const q = query.trim()
      if (!q || isPending) return
      const filters: SearchFilters = {}
      if (languageFilter !== "all") filters.language = languageFilter
      if (minStars > 0) filters.minStars = minStars
      const topics = topicInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      if (topics.length > 0) filters.topics = topics
      startTransition(async () => {
        const data = await searchReposAction(q, filters, mode)
        setResults(data)
      })
    },
    [searchMode, query, isPending, languageFilter, minStars, topicInput]
  )

  const clearFilters = () => {
    setLanguageFilter("all")
    setMinStars(0)
    setTopicInput("")
  }

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const q = query.trim()
      if (!q || isPending) return

      const filters: SearchFilters = {}
      if (languageFilter !== "all") filters.language = languageFilter
      if (minStars > 0) filters.minStars = minStars
      const topics = topicInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      if (topics.length > 0) filters.topics = topics

      startTransition(async () => {
        const data = await searchReposAction(q, filters, searchMode)
        setResults(data)
      })
    },
    [query, isPending, languageFilter, minStars, topicInput, searchMode]
  )

  const MODE_LABELS: Record<SearchMode, string> = {
    hybrid: t.discover.hybrid,
    semantic: t.discover.semantic,
    keyword: t.discover.keyword,
  }

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
            placeholder={t.discover.placeholder}
            className="w-full rounded-md border bg-background pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="submit"
          disabled={!query.trim() || isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          {t.discover.searchButton}
          {activeFilterCount > 0 && (
            <span className="ml-1 rounded-full bg-background/20 px-1.5 text-[11px]">
              {activeFilterCount}
            </span>
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
      </form>

      {/* Search mode toggle */}
      <div className="flex items-center gap-1">
        {(["hybrid", "semantic", "keyword"] as SearchMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => switchMode(mode)}
            disabled={isPending}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              searchMode === mode
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      {/* Filter row */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-3">
          {/* Language */}
          {languages.length > 0 && (
            <select
              value={languageFilter}
              onChange={(e) => setLanguageFilter(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t.discover.languageAll}</option>
              {languages.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          )}

          {/* Min stars */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">{t.discover.minStars}</span>
            {STAR_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setMinStars(minStars === n ? 0 : n)}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  minStars === n
                    ? "bg-foreground text-background"
                    : "bg-background border hover:bg-muted"
                }`}
              >
                {n === 0 ? t.discover.any : n >= 1000 ? `${n / 1000}k` : String(n)}
              </button>
            ))}
          </div>

          {/* Topics */}
          <input
            type="text"
            value={topicInput}
            onChange={(e) => setTopicInput(e.target.value)}
            placeholder={t.discover.topics}
            className="w-40 rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />

          {/* Clear */}
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

      {/* Loading */}
      {isPending && results == null && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="size-4 animate-spin" />
          {t.discover.searching}
        </div>
      )}

      {/* Empty state — before first search */}
      {results == null && !isPending && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="size-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t.discover.emptyState}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.discover.emptyHint}
          </p>
        </div>
      )}

      {/* No results */}
      {results !== null && results.length === 0 && !isPending && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {t.discover.noResults}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.discover.noResultsHint}
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
      {results !== null && results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t.discover.found} <strong className="text-foreground">{results.length}</strong> {t.discover.matching}
          </p>
          <div className="grid gap-3">
            {results.map((r) => (
              <div key={r.repoId} className="rounded-lg border p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/library/${r.repoId}`}
                        className="font-medium text-sm hover:underline truncate"
                      >
                        {r.fullName}
                      </Link>
                      <a
                        href={`https://github.com/${r.fullName}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    </div>
                    {r.summaryOneLine && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {r.summaryOneLine}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {r.language && (
                        <Badge variant="secondary" className="text-xs">
                          {r.language}
                        </Badge>
                      )}
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Star className="size-3" />
                        {r.stars}
                      </span>
                      {r.topics.slice(0, 3).map((topic) => (
                        <Badge key={topic} variant="outline" className="text-xs">
                          {topic}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                    {(r.similarity * 100).toFixed(0)}% {t.discover.match}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
