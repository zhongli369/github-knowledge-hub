import { notFound } from "next/navigation"
import Link from "next/link"
import { Suspense } from "react"
import { auth } from "@/auth"
import { getTranslations } from "@/i18n/language"
import { getAssetDetailAction } from "@/actions/knowledge"
import { ArrowLeft, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { SimilarAssets } from "./similar-assets"
import { AssetContent } from "./asset-content"

const TYPE_COLORS: Record<string, string> = {
  algorithm: "bg-blue-100 text-blue-800",
  pattern: "bg-purple-100 text-purple-800",
  snippet: "bg-gray-100 text-gray-800",
  architecture: "bg-green-100 text-green-800",
  config: "bg-yellow-100 text-yellow-800",
  doc: "bg-orange-100 text-orange-800",
}

interface Props {
  params: Promise<{ assetId: string }>
}

export default async function AssetDetailPage({ params }: Props) {
  const { assetId } = await params
  const session = await auth()

  const t = await getTranslations()

  if (!session?.user?.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-muted-foreground">{t.common.pleaseLogin}</p>
      </div>
    )
  }

  const asset = await getAssetDetailAction(assetId)
  if (!asset) notFound()

  return (
    <div className="space-y-6">
      <Link
        href="/assets"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        {t.common.backToAssets}
      </Link>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">{asset.title}</h1>
          <Badge className={`text-xs ${TYPE_COLORS[asset.assetType] ?? ""}`}>
            {asset.assetType}
          </Badge>
          {asset.difficulty && (
            <Badge variant="outline" className="text-xs">{t.assets[asset.difficulty as keyof typeof t.assets] ?? asset.difficulty}</Badge>
          )}
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {asset.language && (
            <Badge variant="secondary" className="text-xs">{asset.language}</Badge>
          )}
          {asset.repository && (
            <Link
              href={`/library/${asset.repository.id}`}
              className="hover:text-foreground transition-colors"
            >
              {asset.repository.fullName}
            </Link>
          )}
          {asset.sourcePath && (
            <span className="font-mono">{asset.sourcePath}</span>
          )}
          {asset.sourcePath && (
            <a
              href={`https://github.com/${asset.repository?.fullName}/blob/HEAD/${asset.sourcePath}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        {/* Tags */}
        {asset.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {asset.tags.map((t) => (
              <Badge key={t} variant="outline" className="text-xs">{t}</Badge>
            ))}
          </div>
        )}
      </div>

      {/* Summary */}
      {asset.summary && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            {t.assets.aiAnalysis}
          </h2>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{asset.summary}</p>
        </section>
      )}

      {/* Code preview */}
      {asset.content && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            {t.assets.content}
          </h2>
          <Suspense
            fallback={
              <div className="rounded-md border p-3 animate-pulse">
                <div className="h-4 bg-muted rounded w-full" />
              </div>
            }
          >
            <AssetContent content={asset.content} />
          </Suspense>
        </section>
      )}

      <hr className="border-border" />

      {/* Similar Patterns */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t.assets.similarPatterns}
        </h2>
        <Suspense
          fallback={
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border p-3 animate-pulse">
                  <div className="h-4 bg-muted rounded w-3/4" />
                  <div className="h-3 bg-muted rounded w-1/2 mt-2" />
                </div>
              ))}
            </div>
          }
        >
          <SimilarAssets assetId={assetId} />
        </Suspense>
      </section>
    </div>
  )
}
