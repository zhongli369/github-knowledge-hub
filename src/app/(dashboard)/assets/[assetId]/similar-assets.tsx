"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useLanguage } from "@/i18n/LanguageProvider"
import { getSimilarAssetsAction } from "@/actions/knowledge"

interface SimilarResult {
  assetId: string
  title: string
  assetType: string
  language: string | null
  summary: string | null
  repositoryId: string
  repoFullName: string
  similarity: number
}

const TYPE_COLORS: Record<string, string> = {
  algorithm: "bg-blue-100 text-blue-800",
  pattern: "bg-purple-100 text-purple-800",
  snippet: "bg-gray-100 text-gray-800",
  architecture: "bg-green-100 text-green-800",
  config: "bg-yellow-100 text-yellow-800",
  doc: "bg-orange-100 text-orange-800",
}

export function SimilarAssets({ assetId }: { assetId: string }) {
  const { t } = useLanguage()
  const [results, setResults] = useState<SimilarResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getSimilarAssetsAction(assetId)
      .then((data) => { if (!cancelled) setResults(data) })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResults([])
          setError(err instanceof Error ? err.message : "Failed to load similar assets")
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [assetId])

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-3 animate-pulse">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-3 bg-muted rounded w-1/2 mt-2" />
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="size-3.5 shrink-0" />
        {t.assets.similarError}
      </div>
    )
  }

  if (!results || results.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t.assets.noSimilarAssets}</p>
    )
  }

  return (
    <div className="grid gap-2">
      {results.map((r) => (
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
              {(r.similarity * 100).toFixed(0)}% {t.assets.match}
            </span>
          </div>
          {r.summary && (
            <p className="text-xs text-muted-foreground line-clamp-1">{r.summary}</p>
          )}
          <div className="flex items-center gap-1">
            <Badge className={`text-[10px] ${TYPE_COLORS[r.assetType] ?? ""}`}>
              {r.assetType}
            </Badge>
            {r.language && (
              <Badge variant="secondary" className="text-[10px]">{r.language}</Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}