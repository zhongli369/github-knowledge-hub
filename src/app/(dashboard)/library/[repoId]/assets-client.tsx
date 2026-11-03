"use client"

import { useEffect, useState, useCallback, useTransition } from "react"
import { Sparkles, Loader2, CheckCircle2, Code, FileText, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useLanguage } from "@/i18n/LanguageProvider"
import { getRepoAssetsAction, extractAssetsAction } from "@/actions/knowledge"
import { getCollectionsAction, addToCollectionAction } from "@/actions/collections"

interface Asset {
  id: string
  title: string
  description: string | null
  assetType: string
  sourcePath: string | null
  summary: string | null
  language: string | null
  tags: string[]
  difficulty: string | null
}

const TYPE_COLORS: Record<string, string> = {
  algorithm: "bg-blue-100 text-blue-800",
  pattern: "bg-purple-100 text-purple-800",
  snippet: "bg-gray-100 text-gray-800",
  architecture: "bg-green-100 text-green-800",
  config: "bg-yellow-100 text-yellow-800",
  doc: "bg-orange-100 text-orange-800",
}

export function AssetsClient({ repoId }: { repoId: string }) {
  const { t } = useLanguage()
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [queueStatus, setQueueStatus] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [collections, setCollections] = useState<Array<{ id: string; name: string }>>([])
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)
  const [addStatus, setAddStatus] = useState<Record<string, string>>({})

  useEffect(() => {
    getCollectionsAction()
      .then((list) => setCollections(list))
      .catch(() => setCollections([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    getRepoAssetsAction(repoId)
      .then((data) => { if (!cancelled) setAssets(data) })
      .catch(() => { if (!cancelled) setAssets([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [repoId])

  const handleExtract = useCallback(() => {
    startTransition(async () => {
      const result = await extractAssetsAction(repoId)
      if (result.status === "queued") {
        setQueueStatus(t.library.queued)
      } else if (result.status === "already_queued") {
        setQueueStatus(t.library.alreadyQueued)
      }
    })
  }, [repoId, t.library.queued, t.library.alreadyQueued])

  // Loading
  if (loading) {
    return (
      <div className="grid gap-2 md:grid-cols-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-3 animate-pulse">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-3 bg-muted rounded w-1/2 mt-2" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Extract button + status */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleExtract}
          disabled={isPending || queueStatus !== null}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {t.library.extractAssets}
        </button>
        {queueStatus && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3 text-green-600" />
            {queueStatus}
          </span>
        )}
      </div>

      {/* Empty */}
      {(!assets || assets.length === 0) && !queueStatus && (
        <div className="flex flex-col items-center justify-center py-8 text-center rounded-lg border bg-muted/20">
          <Code className="size-6 text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">
            {t.library.noAssets}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.library.extractHint}
          </p>
        </div>
      )}

      {/* Asset cards */}
      {assets && assets.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2">
          {assets.map((a) => (
            <div key={a.id} className="rounded-lg border p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <FileText className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium truncate">
                      {a.title}
                    </span>
                  </div>
                  {a.sourcePath && (
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5 font-mono">
                      {a.sourcePath}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Badge
                    className={`text-[10px] ${TYPE_COLORS[a.assetType] ?? "bg-gray-100 text-gray-800"}`}
                  >
                    {a.assetType}
                  </Badge>
                  <div className="relative">
                    <button
                      onClick={() => setOpenDropdownId(openDropdownId === a.id ? null : a.id)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title={t.library.addToCollection}
                    >
                      <Plus className="size-3.5" />
                    </button>
                    {openDropdownId === a.id && (
                      <div className="absolute right-0 top-full mt-1 z-50 bg-background border rounded-md shadow-lg py-1 min-w-[160px]">
                        {collections.length === 0 ? (
                          <p className="text-xs text-muted-foreground px-3 py-2">
                            {t.library.noCollectionsCreateOne}
                          </p>
                        ) : (
                          collections.map((c) => (
                            <button
                              key={c.id}
                              onClick={() => {
                                startTransition(async () => {
                                  const result = await addToCollectionAction(c.id, a.id)
                                  setAddStatus((prev) => ({ ...prev, [a.id]: result.collectionName || result.status }))
                                  setOpenDropdownId(null)
                                  setTimeout(() => {
                                    setAddStatus((prev) => {
                                      const next = { ...prev }
                                      delete next[a.id]
                                      return next
                                    })
                                  }, 2000)
                                })
                              }}
                              className="w-full text-left text-xs px-3 py-1.5 hover:bg-muted transition-colors"
                            >
                              {c.name}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Add to collection feedback */}
              {addStatus[a.id] && (
                <p className="text-[10px] text-green-600">
                  {t.collections.addedTo} {addStatus[a.id]}
                </p>
              )}

              {a.summary && (
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {a.summary}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-1">
                {a.language && (
                  <Badge variant="secondary" className="text-[10px]">
                    {a.language}
                  </Badge>
                )}
                {a.difficulty && (
                  <Badge variant="outline" className="text-[10px]">
                    {a.difficulty}
                  </Badge>
                )}
                {a.tags.slice(0, 4).map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
