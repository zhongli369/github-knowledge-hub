"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  startClassificationBatch,
  getClassificationProgress,
  type ClassificationMode,
} from "@/actions/classification"
import { Button } from "@/components/ui/button"
import { useLanguage } from "@/i18n/LanguageProvider"
import { Layers, Loader2, Play, Sparkles, RefreshCw } from "lucide-react"
import type { ClassificationProgress } from "./types"

const POLL_INTERVAL_MS = 2000

/**
 * Classification task launcher + progress monitor.
 *
 * Three modes: classify all repos, only unclassified ones, or reclassify
 * everything (requires confirmation). Progress is polled while a task is
 * running; completed/failed tasks can be re-run with the same buttons.
 */
export function ClassificationPanel() {
  const { t } = useLanguage()

  const [starting, setStarting] = useState<ClassificationMode | null>(null)
  const [progress, setProgress] = useState<ClassificationProgress | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [checking, setChecking] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refreshProgress = useCallback(async () => {
    const p = await getClassificationProgress()
    setProgress(p)
    const active = p.pending + p.running > 0
    setIsRunning(active)
    if (!active) stopPolling()
    return p
  }, [stopPolling])

  const startPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(() => {
      refreshProgress().catch(() => {
        // If polling starts failing (e.g. action gone), stop to avoid spam.
        stopPolling()
      })
    }, POLL_INTERVAL_MS)
  }, [refreshProgress, stopPolling])

  // Initial snapshot + resume polling if a task is mid-flight.
  useEffect(() => {
    let cancelled = false
    getClassificationProgress()
      .then((p) => {
        if (cancelled) return
        setProgress(p)
        setChecking(false)
        if (p.pending + p.running > 0) {
          setIsRunning(true)
          startPolling()
        }
      })
      .catch(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
      stopPolling()
    }
  }, [startPolling, stopPolling])

  const handleStart = useCallback(
    async (mode: ClassificationMode) => {
      if (isRunning || starting) return

      if (mode === "reclassify" && !window.confirm(t.classification.reclassifyConfirm)) {
        return
      }

      setStarting(mode)
      try {
        const result = await startClassificationBatch(mode)
        toast.success(
          `${t.classification.enqueued} ${result.enqueued} · ${t.classification.skipped} ${result.skipped} · ${t.classification.total} ${result.total}`
        )
        setIsRunning(result.enqueued > 0)
        if (result.enqueued > 0) startPolling()
        else await refreshProgress()
      } catch {
        toast.error(t.classification.startFailed)
      } finally {
        setStarting(null)
      }
    },
    [isRunning, starting, startPolling, refreshProgress, t.classification]
  )

  const failed = progress?.failed ?? 0
  const total = progress?.total ?? 0
  const processed = progress
    ? (progress.succeeded ?? 0) + progress.skipped + progress.failed
    : 0
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0

  const buttons: {
    mode: ClassificationMode
    label: string
    tipKey: keyof typeof t.classification
    icon: typeof Play
  }[] = [
    {
      mode: "all",
      label: t.classification.classifyAll,
      tipKey: "classifyAllTooltip",
      icon: Sparkles,
    },
    {
      mode: "unclassified",
      label: t.classification.classifyUnclassified,
      tipKey: "classifyUnclassifiedTooltip",
      icon: Play,
    },
    {
      mode: "reclassify",
      label: t.classification.reclassify,
      tipKey: "reclassifyTooltip",
      icon: RefreshCw,
    },
  ]

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{t.classification.title}</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {t.classification.description}
          </p>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {buttons.map((btn) => (
          <Button
            key={btn.mode}
            variant="outline"
            size="sm"
            disabled={isRunning || starting !== null}
            title={t.classification[btn.tipKey]}
            onClick={() => handleStart(btn.mode)}
            className="text-xs h-7"
          >
            {starting === btn.mode ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <btn.icon className="size-3.5" />
            )}
            {btn.label}
          </Button>
        ))}
      </div>

      {/* Progress */}
      {checking ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t.classification.checking}
        </p>
      ) : progress ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t.classification.total}{" "}
              <strong className="text-foreground">{total}</strong>
            </span>
            <span>
              {t.classification.succeeded}{" "}
              <strong className="text-foreground">{progress.succeeded}</strong>
            </span>
            <span>
              {t.classification.skipped}{" "}
              <strong className="text-foreground">{progress.skipped}</strong>
            </span>
            {failed > 0 && (
              <span className="text-destructive">
                {t.classification.failed} <strong>{failed}</strong>
              </span>
            )}
            {isRunning && (
              <>
                <span>
                  {t.classification.pending}{" "}
                  <strong className="text-foreground">{progress.pending}</strong>
                </span>
                <span>
                  {t.classification.running}{" "}
                  <strong className="text-foreground">{progress.running}</strong>
                </span>
              </>
            )}
          </div>

          {/* Progress bar */}
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                failed > 0 && !isRunning ? "bg-amber-500" : "bg-foreground"
              }`}
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </div>

          {isRunning ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t.classification.runningNow}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {failed > 0
                ? `${t.classification.completed} · ${t.classification.withFailures}`
                : t.classification.allDone}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t.classification.idle}</p>
      )}
    </div>
  )
}