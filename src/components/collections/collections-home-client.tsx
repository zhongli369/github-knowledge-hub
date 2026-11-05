"use client"

import { useCallback, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Toaster } from "sonner"
import { FolderOpen, Layers } from "lucide-react"
import { useLanguage } from "@/i18n/LanguageProvider"
import { ClassificationPanel } from "./classification-panel"
import { CollectionsClient } from "@/app/(dashboard)/collections/collections-client"
import type { CategoryCollectionSummary } from "./types"

interface LegacyCollectionItem {
  id: string
  name: string
  description: string | null
  _count: { assets: number }
  updatedAt: string
}

type Tab = "categories" | "collections"

export function CollectionsHomeClient({
  categories,
  legacyCollections,
}: {
  categories: CategoryCollectionSummary[]
  legacyCollections: LegacyCollectionItem[]
}) {
  const { t } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<Tab>(() =>
    searchParams.get("view") === "collections" ? "collections" : "categories"
  )

  const switchTab = useCallback(
    (next: Tab) => {
      setTab(next)
      router.replace(next === "categories" ? "/collections" : "/collections?view=collections", {
        scroll: false,
      })
    },
    [router]
  )

  const tabCls = (active: boolean) =>
    `inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
      active
        ? "border-foreground font-medium text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"
    }`

  return (
    <div className="space-y-6">
      <Toaster richColors position="bottom-right" />

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b">
        <button onClick={() => switchTab("categories")} className={tabCls(tab === "categories")}>
          <Layers className="size-4" />
          {t.categoryCollections.title}
        </button>
        <button
          onClick={() => switchTab("collections")}
          className={tabCls(tab === "collections")}
        >
          <FolderOpen className="size-4" />
          {t.categoryCollections.myCollections}
        </button>
      </div>

      {tab === "categories" ? (
        <div className="space-y-6">
          {/* Classification task entry */}
          <ClassificationPanel />

          {categories.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Layers className="size-8 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">
                {t.categoryCollections.noCategories}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {categories.map((c) => (
                <Link
                  key={c.id}
                  href={`/collections/${c.slug}`}
                  className="group rounded-lg border p-4 space-y-2 transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium text-sm group-hover:underline">{c.name}</h3>
                    <span className="shrink-0 rounded-4xl bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {c.repositoryCount} {t.categoryCollections.repositoriesCount}
                    </span>
                  </div>
                  {c.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{c.description}</p>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : (
        <CollectionsClient
          collections={legacyCollections}
          isEmpty={legacyCollections.length === 0}
        />
      )}
    </div>
  )
}