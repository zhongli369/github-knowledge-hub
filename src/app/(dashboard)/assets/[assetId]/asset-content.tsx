"use client"

import { useState } from "react"
import { useLanguage } from "@/i18n/LanguageProvider"

export function AssetContent({ content }: { content: string }) {
  const { t } = useLanguage()
  const lines = content.split("\n")
  const hasMore = lines.length > 30
  const [expanded, setExpanded] = useState(false)

  const visible = expanded ? lines : lines.slice(0, 30)

  return (
    <div className="space-y-2">
      <pre className="rounded-md border bg-muted/30 p-3 text-xs font-mono overflow-x-auto max-h-[500px] overflow-y-auto whitespace-pre-wrap">
        {visible.join("\n")}
      </pre>
      {hasMore && (
        <button
          onClick={() => setExpanded((p) => !p)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? t.assets.showLess : `${t.assets.showMore} (${lines.length - 30} ${t.assets.moreLines})`}
        </button>
      )}
    </div>
  )
}
