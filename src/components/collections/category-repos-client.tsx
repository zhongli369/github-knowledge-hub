"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Toaster, toast } from "sonner"
import {
  Star,
  ExternalLink,
  Search,
  X,
  Loader2,
  Plus,
  Trash2,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useLanguage } from "@/i18n/LanguageProvider"
import { listCategoryRepositories, setRepositoryCategoryMembership } from "@/actions/collections"
import { getMyRepos } from "@/actions/repos"
import type { CategoryReposResponse, CategorySort } from "./types"

const PAGE_SIZE = 10

const STATUS_STYLES: Record<string, string> = {
  new: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  analyzing: "border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  active: "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
  archived: "border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400",
}

function formatDate(value: string | number | Date, locale: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function formatCount(template: string, n: number): string {
  return template.replace("%d", String(n))
}

interface PickerRepo {
  id: string
  fullName: string
  description: string | null
  language: string | null
  topics: string[]
}

export function CategoryReposClient({
  slug,
  categoryName,
  categoryDescription,
  initial,
}: {
  slug: string
  categoryName: string
  categoryDescription: string | null
  initial: CategoryReposResponse
}) {
  const { t, locale } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [data, setData] = useState<CategoryReposResponse>(initial)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState(searchParams.get("q") ?? "")
  const [debouncedQ, setDebouncedQ] = useState(searchParams.get("q") ?? "")
  const [lang, setLang] = useState(searchParams.get("lang") ?? "all")
  const [sort, setSort] = useState<CategorySort>(
    (() => {
      const s = searchParams.get("sort")
      return s === "name" || s === "updated" ? s : "stars"
    })()
  )
  const [page, setPage] = useState(() => {
    const p = parseInt(searchParams.get("page") ?? "1", 10)
    return Number.isFinite(p) && p >= 1 ? p : 1
  })
  const [refreshKey, setRefreshKey] = useState(0)

  // Removal / picker state
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerRepos, setPickerRepos] = useState<PickerRepo[] | null>(null)
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set())
  const [pickerBusy, setPickerBusy] = useState(false)
  const [pickerQuery, setPickerQuery] = useState("")

  // Debounce the search box.
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedQ(q)
      setPage(1)
    }, 350)
    return () => clearTimeout(id)
  }, [q])

  // Fetch the list when any filter/page changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listCategoryRepositories({
      slug,
      search: debouncedQ,
      language: lang === "all" ? "" : lang,
      sort,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((res) => {
        if (cancelled) return
        setData(res)
        if (res.items.length === 0 && res.page > 1 && res.total > 0) {
          // Current page no longer exists after a deletion; jump to last page.
          setPage(Math.max(1, Math.ceil(res.total / PAGE_SIZE)))
          return
        }
        const params = new URLSearchParams()
        if (debouncedQ) params.set("q", debouncedQ)
        if (lang !== "all") params.set("lang", lang)
        if (sort !== "stars") params.set("sort", sort)
        if (page > 1) params.set("page", String(page))
        const qs = params.toString()
        router.replace(qs ? `/collections/${slug}?${qs}` : `/collections/${slug}`, {
          scroll: false,
        })
      })
      .catch(() => {
        if (!cancelled) toast.error(t.categoryCollections.loadFailed)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQ, lang, sort, page, refreshKey, slug, router, t.categoryCollections.loadFailed])

  const languages = data.languages ?? []
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
  const hasActiveFilters = q.length > 0 || lang !== "all" || sort !== "stars" || page > 1

  const statusLabel = (s: string | undefined): string => {
    const value = s || "new"
    const key = `status${value.charAt(0).toUpperCase() + value.slice(1)}`
    const rec = t.categoryCollections as unknown as Record<string, string>
    return rec[key] ?? value
  }

  const clearAll = useCallback(() => {
    setQ("")
    setLang("all")
    setSort("stars")
    setPage(1)
    router.replace(`/collections/${slug}`, { scroll: false })
  }, [slug, router])

  // ── Remove from category ──────────────────────────────────────
  const handleRemove = useCallback(
    async (repoId: string) => {
      if (removing.has(repoId)) return
      setRemoving((prev) => new Set(prev).add(repoId))
      try {
        await setRepositoryCategoryMembership({ repositoryId: repoId, slug, included: false })
        toast.success(t.categoryCollections.removedFromCategory)
        setRefreshKey((k) => k + 1)
      } catch {
        toast.error(t.categoryCollections.removeFailed)
      } finally {
        setRemoving((prev) => {
          const next = new Set(prev)
          next.delete(repoId)
          return next
        })
      }
    },
    [removing, slug, t.categoryCollections.removedFromCategory, t.categoryCollections.removeFailed]
  )

  // ── Add repositories picker ────────────────────────────────────
  const openPicker = useCallback(async () => {
    setPickerOpen(true)
    setPickerRepos(null)
    setPickerSelected(new Set())
    setPickerQuery("")
    try {
      const [allRepos, members] = await Promise.all([
        getMyRepos(),
        listCategoryRepositories({
          slug,
          search: "",
          language: "",
          sort: "name",
          page: 1,
          pageSize: Math.max(data.total, 1),
        }),
      ])
      const memberIds = new Set(members.items.map((m) => m.id))
      const candidates = allRepos
        .filter((r) => !memberIds.has(r.id))
        .map((r) => ({
          id: r.id,
          fullName: r.fullName,
          description: r.description,
          language: r.language,
          topics: r.topics,
        }))
      setPickerRepos(candidates)
    } catch {
      toast.error(t.categoryCollections.loadFailed)
      setPickerRepos([])
    }
  }, [slug, data.total, t.categoryCollections.loadFailed])

  const togglePickerSelect = useCallback((id: string) => {
    setPickerSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const filteredPickerRepos = useMemo(() => {
    const repos = pickerRepos ?? []
    const qq = pickerQuery.trim().toLowerCase()
    const filtered = qq
      ? repos.filter((r) =>
          [r.fullName, r.description ?? "", r.topics.join(" ")].join(" ").toLowerCase().includes(qq)
        )
      : repos
    return filtered.slice(0, 200)
  }, [pickerRepos, pickerQuery])

  const handleAddSelected = useCallback(async () => {
    const ids = [...pickerSelected]
    if (ids.length === 0 || pickerBusy) return
    setPickerBusy(true)
    try {
      for (const id of ids) {
        await setRepositoryCategoryMembership({ repositoryId: id, slug, included: true })
      }
      toast.success(formatCount(t.categoryCollections.addReposSuccess, ids.length))
      setPickerOpen(false)
      setRefreshKey((k) => k + 1)
      router.refresh()
    } catch {
      toast.error(t.categoryCollections.addFailed)
    } finally {
      setPickerBusy(false)
    }
  }, [pickerSelected, pickerBusy, slug, t.categoryCollections.addReposSuccess, t.categoryCollections.addFailed, router])

  return (
    <div className="space-y-4">
      <Toaster richColors position="bottom-right" />

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{categoryName}</h1>
        {categoryDescription && (
          <p className="text-muted-foreground mt-1">{categoryDescription}</p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {data.total} {t.categoryCollections.repositoriesCount}
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.categoryCollections.searchPlaceholder}
            className="w-full rounded-md border bg-background pl-8 pr-8 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {languages.length > 1 && (
          <select
            value={lang}
            onChange={(e) => {
              setLang(e.target.value)
              setPage(1)
            }}
            className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={loading}
          >
            <option value="all">{t.categoryCollections.languageAll}</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}

        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as CategorySort)
            setPage(1)
          }}
          className="rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={loading}
        >
          <option value="stars">
            {t.categoryCollections.sortPrefix}
            {t.categoryCollections.sortStars}
          </option>
          <option value="updated">
            {t.categoryCollections.sortPrefix}
            {t.categoryCollections.sortUpdated}
          </option>
          <option value="name">
            {t.categoryCollections.sortPrefix}
            {t.categoryCollections.sortName}
          </option>
        </select>

        <Button variant="outline" size="sm" onClick={openPicker} className="text-xs h-7">
          <Plus className="size-3" />
          {t.categoryCollections.addRepos}
        </Button>

        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>
          {t.categoryCollections.showing} <strong className="text-foreground">{data.items.length}</strong>{" "}
          {t.categoryCollections.of} {data.total}
        </span>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearAll} className="text-xs h-6">
            {t.categoryCollections.clearAllFilters}
          </Button>
        )}
      </div>

      {/* Cards */}
      {data.items.length > 0 ? (
        <div className="grid gap-3">
          {data.items.map((item) => (
            <div key={item.id} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/library/${item.id}`}
                      className="font-medium text-sm hover:underline truncate"
                    >
                      {item.fullName}
                    </Link>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      title={t.categoryCollections.openInGitHub}
                    >
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                  {item.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">{item.description}</p>
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
                    {(item.topics ?? []).slice(0, 4).map((topic) => (
                      <Badge key={topic} variant="outline" className="text-xs">
                        {topic}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <span
                    className={`rounded-md border px-2 py-1 text-xs font-medium ${STATUS_STYLES[item.status] ?? ""}`}
                  >
                    {statusLabel(item.status)}
                  </span>
                  <button
                    onClick={() => handleRemove(item.id)}
                    disabled={removing.has(item.id)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                  >
                    {removing.has(item.id) ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                    {t.categoryCollections.removeFromCategory}
                  </button>
                </div>
              </div>

              {/* Keywords */}
              {(item.keywords ?? []).length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-muted-foreground">
                    {t.categoryCollections.keywords}:
                  </span>
                  {(item.keywords ?? []).slice(0, 8).map((kw) => (
                    <Badge key={kw} variant="ghost" className="text-[11px]">
                      {kw}
                    </Badge>
                  ))}
                </div>
              )}

              {/* AI summary */}
              <div className="space-y-0.5">
                <p className="text-[11px] font-medium text-muted-foreground">
                  {t.categoryCollections.aiSummary}
                </p>
                {item.summary ? (
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
                    {item.summary}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground/60 italic">
                    {t.categoryCollections.noSummary}
                  </p>
                )}
              </div>

              {item.note && (
                <p className="text-xs text-muted-foreground line-clamp-1">{item.note}</p>
              )}

              {/* Meta footer */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {item.classifierSource && (
                  <span>
                    {t.categoryCollections.classifierSource}:{" "}
                    {item.classifierSource === "manual"
                      ? t.categoryCollections.classifierSourceManual
                      : t.categoryCollections.classifierSourceAuto}
                  </span>
                )}
                {item.updatedAt && (
                  <span>
                    {t.categoryCollections.updated} {formatDate(item.updatedAt, locale)}
                  </span>
                )}
                <Link
                  href={`/library/${item.id}`}
                  className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                >
                  {t.categoryCollections.viewDetail}
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <SlidersHorizontal className="size-8 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            {hasActiveFilters
              ? t.categoryCollections.noReposMatch
              : t.categoryCollections.noReposInCategory}
          </p>
        </div>
      )}

      {/* Pagination */}
      {data.total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="text-xs h-7"
          >
            <ChevronLeft className="size-3" />
            {t.common.prevPage}
          </Button>
          <span className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="text-xs h-7"
          >
            {t.common.nextPage}
            <ChevronRight className="size-3" />
          </Button>
        </div>
      )}

      {/* Add repositories picker */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <div className="bg-background rounded-lg border shadow-lg max-w-lg w-full max-h-[70vh] flex flex-col m-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-medium text-sm">{t.categoryCollections.addReposTitle}</h3>
              <button
                onClick={() => setPickerOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                disabled={pickerBusy}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="p-3 border-b">
              <input
                type="text"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder={t.categoryCollections.searchReposPlaceholder}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">
                {t.categoryCollections.addReposHint}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {pickerRepos === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                  <Loader2 className="size-4 animate-spin" />
                  {t.categoryCollections.loadingRepos}
                </div>
              ) : filteredPickerRepos.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {t.categoryCollections.noReposAvailable}
                </p>
              ) : (
                filteredPickerRepos.map((r) => (
                  <label
                    key={r.id}
                    className={`flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                      pickerSelected.has(r.id)
                        ? "border-foreground bg-muted/50"
                        : "hover:bg-muted/30"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={pickerSelected.has(r.id)}
                      onChange={() => togglePickerSelect(r.id)}
                      className="mt-0.5"
                      disabled={pickerBusy}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{r.fullName}</p>
                      {r.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {r.description}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        {r.language && (
                          <Badge variant="secondary" className="text-[10px]">
                            {r.language}
                          </Badge>
                        )}
                        {r.topics.slice(0, 3).map((topic) => (
                          <Badge key={topic} variant="outline" className="text-[10px]">
                            {topic}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="flex items-center gap-2 p-4 border-t">
              <Button
                size="sm"
                onClick={handleAddSelected}
                disabled={pickerSelected.size === 0 || pickerBusy}
              >
                {pickerBusy ? (
                  <Loader2 className="size-3.5 animate-spin mr-1" />
                ) : null}
                {t.categoryCollections.addSelected} ({pickerSelected.size})
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(false)} disabled={pickerBusy}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
