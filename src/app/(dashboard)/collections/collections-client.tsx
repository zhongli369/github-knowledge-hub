"use client"

import { useState, useCallback, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Plus, Trash2, Loader2, Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useLanguage } from "@/i18n/LanguageProvider"
import { createCollectionAction, deleteCollectionAction } from "@/actions/collections"

interface CollectionItem {
  id: string
  name: string
  description: string | null
  _count: { assets: number }
  updatedAt: string
}

export function CollectionsClient({
  collections: initial,
  isEmpty: forceEmpty,
}: {
  collections: CollectionItem[]
  isEmpty?: boolean
}) {
  const { t } = useLanguage()
  const router = useRouter()
  const [collections, setCollections] = useState(initial)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [isPending, startTransition] = useTransition()

  const handleCreate = useCallback(() => {
    if (!name.trim()) return
    startTransition(async () => {
      const c = await createCollectionAction(name.trim(), description.trim() || undefined)
      setCollections((prev) => [
        {
          id: c.id,
          name: c.name,
          description: c.description,
          _count: { assets: 0 },
          updatedAt: c.updatedAt.toISOString(),
        },
        ...prev,
      ])
      setName("")
      setDescription("")
      setCreating(false)
    })
  }, [name, description])

  const handleDelete = useCallback(
    (collection: CollectionItem) => {
      if (!window.confirm(`${t.collections.deleteConfirm} "${collection.name}"?`)) return
      startTransition(async () => {
        await deleteCollectionAction(collection.id)
        setCollections((prev) => prev.filter((c) => c.id !== collection.id))
        router.refresh()
      })
    },
    [router, t.collections.deleteConfirm]
  )

  if (forceEmpty && collections.length === 0) {
    return (
      <div className="space-y-4">
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            <Plus className="size-4" />
            {t.collections.newCollection}
          </button>
        )}
        {creating && (
          <div className="rounded-lg border p-4 space-y-3 max-w-md">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.collections.name}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.collections.descriptionLabel}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate} disabled={!name.trim() || isPending}>
                {isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
                {t.collections.create}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Layers className="size-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {t.collections.noCollections}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Create button / form */}
      {!creating ? (
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90"
        >
          <Plus className="size-4" />
          {t.collections.newCollection}
        </button>
      ) : (
        <div className="rounded-lg border p-4 space-y-3 max-w-md">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.collections.name}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t.collections.descriptionLabel}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate} disabled={!name.trim() || isPending}>
              {isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null}
              {t.collections.create}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      )}

      {/* Card grid */}
      <div className="grid gap-3 md:grid-cols-2">
        {collections.map((c) => (
          <div key={c.id} className="rounded-lg border p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/collections/${c.id}`}
                className="font-medium text-sm hover:underline"
              >
                {c.name}
              </Link>
              <button
                onClick={() => handleDelete(c)}
                className="text-muted-foreground hover:text-destructive shrink-0"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            {c.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">{c.description}</p>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                <strong className="text-foreground">{c._count.assets}</strong> {t.collections.assetsCount}
              </span>
              <span>
                {t.collections.updated}{" "}
                {new Date(c.updatedAt).toLocaleDateString("zh-CN", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
