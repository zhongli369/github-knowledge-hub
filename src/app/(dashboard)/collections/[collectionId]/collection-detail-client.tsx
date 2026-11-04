"use client"

import { useState, useCallback, useTransition, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plus, X, Loader2, FileText, Pencil, Check, ChevronUp, ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useLanguage } from "@/i18n/LanguageProvider"
import {
  addAssetsToCollectionAction,
  removeAssetsFromCollectionAction,
  updateCollectionAction,
  reorderCollectionAssetsAction,
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
  initialName,
  initialDescription,
  initialAssets,
}: {
  collectionId: string
  initialName: string
  initialDescription: string | null
  initialAssets: (Asset & { addedAt: string })[]
}) {
  const { t } = useLanguage()
  const router = useRouter()

  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription ?? "")
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(initialName)
  const [editDescription, setEditDescription] = useState(initialDescription ?? "")
  const [saveError, setSaveError] = useState<string | null>(null)

  const [assets, setAssets] = useState(initialAssets)
  const [showPicker, setShowPicker] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const startEdit = useCallback(() => {
    setEditName(name)
    setEditDescription(description ?? "")
    setSaveError(null)
    setEditing(true)
  }, [name, description])

  const saveEdit = useCallback(() => {
    if (!editName.trim()) return
    startTransition(async () => {
      try {
        const updated = await updateCollectionAction(collectionId, {
          name: editName.trim(),
          description: editDescription.trim() || null,
        })
        setName(updated.name)
        setDescription(updated.description ?? "")
        setEditing(false)
        setSaveError(null)
        router.refresh()
      } catch {
        setSaveError(t.collections.updateFailed)
      }
    })
  }, [editName, editDescription, collectionId, router, t.collections.updateFailed])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setSaveError(null)
  }, [])

  const handleRemove = useCallback(
    (assetId: string) => {
      startTransition(async () => {
        try {
          await removeAssetsFromCollectionAction(collectionId, [assetId])
          setAssets((prev) => prev.filter((a) => a.id !== assetId))
          router.refresh()
        } catch {
          setSaveError(t.collections.updateFailed)
        }
      })
    },
    [collectionId, router, t.collections.updateFailed]
  )

  const toggleSelect = useCallback((assetId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }, [])

  const cancelSelecting = useCallback(() => {
    setSelecting(false)
    setSelected(new Set())
  }, [])

  const handleRemoveSelected = useCallback(() => {
    if (selected.size === 0) return
    if (!window.confirm(t.collections.removeSelectedConfirm)) return
    startTransition(async () => {
      try {
        await removeAssetsFromCollectionAction(collectionId, [...selected])
        setAssets((prev) => prev.filter((a) => !selected.has(a.id)))
        setSelected(new Set())
        setSelecting(false)
        router.refresh()
      } catch {
        setSaveError(t.collections.updateFailed)
      }
    })
  }, [selected, collectionId, router, t.collections.removeSelectedConfirm, t.collections.updateFailed])

  const handleMove = useCallback(
    (index: number, dir: -1 | 1) => {
      const target = index + dir
      if (target < 0 || target >= assets.length) return
      const previous = assets
      const next = [...assets]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      setReorderError(null)
      setAssets(next)
      startTransition(async () => {
        try {
          await reorderCollectionAssetsAction(collectionId, next.map((a) => a.id))
          router.refresh()
        } catch {
          setAssets(previous)
          setReorderError(t.collections.reorderFailed)
        }
      })
    },
    [assets, collectionId, router, t.collections.reorderFailed]
  )

  return (
    <div className="space-y-4">
      {/* Editable header */}
      {editing ? (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Pencil className="size-4 text-muted-foreground mt-2 shrink-0" />
            <div className="flex-1 space-y-3">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={t.collections.name}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />
              <input
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={t.collections.descriptionLabel}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveEdit} disabled={!editName.trim() || isPending}>
              {isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Check className="size-3.5 mr-1" />}
              {t.common.save}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit}>
              {t.common.cancel}
            </Button>
          </div>
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        </div>
      ) : (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
            {description && (
              <p className="text-muted-foreground mt-1">{description}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              {assets.length} {t.collections.assetsCount}
            </p>
          </div>
          <button
            onClick={startEdit}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title={t.collections.edit}
          >
            <Pencil className="size-4" />
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="size-3.5" />
          {t.collections.addAssets}
        </button>
        {selecting ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleRemoveSelected}
              disabled={selected.size === 0 || isPending}
            >
              {isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
              {t.collections.removeSelected} ({selected.size})
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelSelecting}>
              {t.common.cancel}
            </Button>
          </>
        ) : assets.length > 0 ? (
          <button
            onClick={() => setSelecting(true)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.collections.manage}
          </button>
        ) : null}
      </div>

      {/* Asset picker modal */}
      {showPicker && (
        <AssetPicker
          collectionId={collectionId}
          existingAssetIds={new Set(assets.map((a) => a.id))}
          onClose={() => setShowPicker(false)}
          onAdd={(added) => {
            const stamped = added.map((a) => ({ ...a, addedAt: new Date().toISOString() }))
            setAssets((prev) => [...stamped, ...prev])
          }}
          t={t}
        />
      )}

      {reorderError && <p className="text-xs text-destructive">{reorderError}</p>}

      {/* Assets */}
      {assets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center rounded-lg border bg-muted/20">
          <FileText className="size-6 text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">
            {t.collections.noAssetsInCollection}
          </p>
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {assets.map((a, index) => (
            <div key={a.id} className="rounded-lg border p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 flex items-start gap-2">
                  {selecting && (
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggleSelect(a.id)}
                      className="mt-0.5 shrink-0"
                    />
                  )}
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
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!selecting && (
                    <div className="flex flex-col">
                      <button
                        onClick={() => handleMove(index, -1)}
                        disabled={isPending || index === 0}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title={t.collections.moveUp}
                      >
                        <ChevronUp className="size-3.5" />
                      </button>
                      <button
                        onClick={() => handleMove(index, 1)}
                        disabled={isPending || index === assets.length - 1}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title={t.collections.moveDown}
                      >
                        <ChevronDown className="size-3.5" />
                      </button>
                    </div>
                  )}
                  <Badge className={`text-[10px] ${TYPE_COLORS[a.assetType] ?? "bg-gray-100 text-gray-800"}`}>
                    {a.assetType}
                  </Badge>
                  {!selecting && (
                    <button
                      onClick={() => handleRemove(a.id)}
                      className="text-muted-foreground hover:text-destructive"
                      disabled={isPending}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
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
      )}
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
  onAdd: (assets: Asset[]) => void
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

  const [error, setError] = useState<string | null>(null)

  const handleAdd = () => {
    startTransition(async () => {
      const ids = [...selected]
      if (ids.length === 0) return
      try {
        await addAssetsToCollectionAction(collectionId, ids)
        const added = assets?.filter((a) => selected.has(a.id)) ?? []
        if (added.length > 0) onAdd(added)
        onClose()
      } catch {
        setError(t.collections.updateFailed)
      }
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
          {error && <p className="text-xs text-destructive mr-auto">{error}</p>}
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