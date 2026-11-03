"use client"

import { useState, useCallback, useTransition, useEffect } from "react"
import Link from "next/link"
import { Plus, X, Loader2, FileText } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useLanguage } from "@/i18n/LanguageProvider"
import {
  addToCollectionAction,
  removeFromCollectionAction,
} from "@/actions/collections"
import { getAllUserAssetsAction } from "@/actions/knowledge"

interface Asset {
  id: string
  title: string
  assetType: string
  sourcePath: string | null
  summary: string | null
  language: string | null
  tags: string[]
  difficulty: string | null
  repositoryId: string
}

const TYPE_COLORS: Record<string, string> = {
  algorithm: "bg-blue-100 text-blue-800",
  pattern: "bg-purple-100 text-purple-800",
  snippet: "bg-gray-100 text-gray-800",
  architecture: "bg-green-100 text-green-800",
  config: "bg-yellow-100 text-yellow-800",
  doc: "bg-orange-100 text-orange-800",
}

export function CollectionDetailClient({
  collectionId,
  initialAssets,
}: {
  collectionId: string
  initialAssets: (Asset & { addedAt: string })[]
}) {
  const { t } = useLanguage()
  const [assets, setAssets] = useState(initialAssets)
  const [showPicker, setShowPicker] = useState(false)
  const [isPending, startTransition] = useTransition()

  const handleRemove = useCallback(
    (assetId: string) => {
      startTransition(async () => {
        await removeFromCollectionAction(collectionId, assetId)
        setAssets((prev) => prev.filter((a) => a.id !== assetId))
      })
    },
    [collectionId]
  )

  if (assets.length === 0 && !showPicker) {
    return (
      <div className="space-y-3">
        <button
          onClick={() => setShowPicker(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="size-3.5" />
          {t.collections.addAssets}
        </button>
        <div className="flex flex-col items-center justify-center py-12 text-center rounded-lg border bg-muted/20">
          <FileText className="size-6 text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">
            {t.collections.noAssetsInCollection}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="size-3.5" />
          {t.collections.addAssets}
        </button>
      </div>

      {/* Asset picker modal */}
      {showPicker && (
        <AssetPicker
          collectionId={collectionId}
          existingAssetIds={new Set(assets.map((a) => a.id))}
          onClose={() => setShowPicker(false)}
          onAdd={(asset) => {
            setAssets((prev) => [{ ...asset, addedAt: new Date().toISOString() }, ...prev])
          }}
          t={t}
        />
      )}

      {/* Asset cards */}
      <div className="grid gap-2 md:grid-cols-2">
        {assets.map((a) => (
          <div key={a.id} className="rounded-lg border p-3 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <FileText className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium truncate">{a.title}</span>
                </div>
                {a.sourcePath && (
                  <p className="text-[10px] text-muted-foreground truncate mt-0.5 font-mono">
                    {a.sourcePath}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Badge className={`text-[10px] ${TYPE_COLORS[a.assetType] ?? "bg-gray-100 text-gray-800"}`}>
                  {a.assetType}
                </Badge>
                <button
                  onClick={() => handleRemove(a.id)}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={isPending}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
            {a.summary && (
              <p className="text-xs text-muted-foreground line-clamp-2">{a.summary}</p>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {a.language && (
                <Badge variant="secondary" className="text-[10px]">{a.language}</Badge>
              )}
              <Link
                href={`/library/${a.repositoryId}`}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                {t.library.sourceRepo}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Asset Picker (inline modal) ──────────────────────────────────

function AssetPicker({
  collectionId,
  existingAssetIds,
  onClose,
  onAdd,
  t,
}: {
  collectionId: string
  existingAssetIds: Set<string>
  onClose: () => void
  onAdd: (asset: Asset) => void
  t: ReturnType<typeof useLanguage>["t"]
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    getAllUserAssetsAction().then(setAssets)
  }, [])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleAdd = () => {
    startTransition(async () => {
      for (const id of selected) {
        const result = await addToCollectionAction(collectionId, id)
        if (result.status === "added") {
          const asset = assets?.find((a) => a.id === id)
          if (asset) onAdd(asset)
        }
      }
      onClose()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
      <div className="bg-background rounded-lg border shadow-lg max-w-lg w-full max-h-[70vh] flex flex-col m-4">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-medium text-sm">{t.collections.addAssetsTitle}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {assets === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="size-4 animate-spin" />
              {t.collections.loadingAssets}
            </div>
          ) : assets.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t.collections.noAssetsAvailable}
            </p>
          ) : (
            assets
              .filter((a) => !existingAssetIds.has(a.id))
              .slice(0, 100)
              .map((a) => (
                <label
                  key={a.id}
                  className={`flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                    selected.has(a.id) ? "border-foreground bg-muted/50" : "hover:bg-muted/30"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{a.title}</p>
                    <p className="text-[10px] text-muted-foreground font-mono truncate">
                      {a.sourcePath}
                    </p>
                    <div className="flex items-center gap-1 mt-1">
                      <Badge className={`text-[10px] ${TYPE_COLORS[a.assetType] ?? ""}`}>
                        {a.assetType}
                      </Badge>
                      {a.language && (
                        <Badge variant="secondary" className="text-[10px]">
                          {a.language}
                        </Badge>
                      )}
                    </div>
                  </div>
                </label>
              ))
          )}
        </div>
        <div className="flex items-center gap-2 p-4 border-t">
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={selected.size === 0 || isPending}
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin mr-1" />
            ) : null}
            {t.collections.addSelected} ({selected.size})
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
        </div>
      </div>
    </div>
  )
}
