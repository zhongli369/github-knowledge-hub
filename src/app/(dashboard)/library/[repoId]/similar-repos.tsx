"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Star, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { getSimilarReposAction } from "@/actions/discover"
import type { SearchResult } from "@/services/llm/repo-embedding.service"

export function SimilarRepos({ repoId }: { repoId: string }) {
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getSimilarReposAction(repoId)
      .then((data) => {
        if (!cancelled) setResults(data)
      })
      .catch(() => {
        if (!cancelled) setResults([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [repoId])

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

  if (!results || results.length === 0) return null

  return (
    <div className="grid gap-2">
      {results.map((r) => (
        <div key={r.repoId} className="rounded-lg border p-3 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <Link
                  href={`/library/${r.repoId}`}
                  className="text-sm font-medium hover:underline truncate"
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
                <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                  {r.summaryOneLine}
                </p>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">
              {(r.similarity * 100).toFixed(0)}%
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {r.language && (
              <Badge variant="secondary" className="text-[10px]">
                {r.language}
              </Badge>
            )}
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <Star className="size-2.5" />
              {r.stars}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
