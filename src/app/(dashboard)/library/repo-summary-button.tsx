"use client"

import React, { useState, useCallback } from "react"
import {
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  RotateCw,
  Clock,
  CheckCircle2,
  Cpu,
  Hash,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useLanguage } from "@/i18n/LanguageProvider"
import {
  analyzeRepositoryAction,
  getRepositoryAnalysisAction,
  retryAnalysisAction,
  type AnalysisMeta,
  type AnalysisErrorCode,
} from "@/actions/analysis"
import type { RepoSummary } from "@/services/llm"

interface Props {
  repoId: string
  initialStatus: string
  batchGenerating?: boolean
}

// ── Helpers ──────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ── Section ──────────────────────────────────────────────────────

function SummarySection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────

export function RepoSummaryButton({ repoId, initialStatus, batchGenerating }: Props) {
  const { t } = useLanguage()
  const [summary, setSummary] = useState<RepoSummary | null>(null)
  const [meta, setMeta] = useState<AnalysisMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<AnalysisErrorCode | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)

  function statusBadge(status: AnalysisMeta["status"]) {
    switch (status) {
      case "not_generated":
        return <Badge variant="outline" className="text-xs border-dashed">{t.library.notGenerated}</Badge>
      case "pending":
      case "running":
        return <Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-800">{t.library.generatingStatus}</Badge>
      case "completed":
        return <Badge variant="secondary" className="text-xs bg-green-100 text-green-800">{t.library.ready}</Badge>
      case "failed":
        return <Badge variant="destructive" className="text-xs">{t.library.failed}</Badge>
    }
  }

  function errorHint(code: AnalysisErrorCode | null): string | null {
    switch (code) {
      case "API_KEY_MISSING":
        return "Set OPENAI_API_KEY in .env to enable AI analysis."
      case "LLM_JSON_PARSE_FAILED":
        return "The AI returned an unexpected format. Try again."
      case "LLM_CALL_FAILED":
        return "The AI service is temporarily unavailable. Try again later."
      case "NOT_AUTHENTICATED":
        return "Please log in again."
      case "REPO_NOT_FOUND":
        return "This repository is no longer available."
      default:
        return null
    }
  }

  const load = useCallback(async () => {
    if (loaded) {
      setExpanded((p) => !p)
      return
    }

    setLoaded(true)
    setLoading(true)

    if (initialStatus === "not_generated") {
      setLoading(false)
      setExpanded(true)
      return
    }

    const result = await getRepositoryAnalysisAction(repoId)
    if (result.summary) setSummary(result.summary)
    if (result.meta) setMeta(result.meta)
    if (result.error) {
      setError(result.error)
      setErrorCode(result.errorCode)
    }
    setLoading(false)
    setExpanded(true)
  }, [loaded, initialStatus, repoId])

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    setErrorCode(null)

    const result = await analyzeRepositoryAction(repoId)
    if (result.summary) {
      setSummary(result.summary)
    }
    if (result.meta) {
      setMeta(result.meta)
    }
    if (result.error) {
      setError(result.error)
      setErrorCode(result.errorCode)
    }
    setExpanded(true)
    setLoaded(true)
    setLoading(false)
  }, [repoId])

  const retry = useCallback(async () => {
    setLoading(true)
    setError(null)
    setErrorCode(null)

    const result = await retryAnalysisAction(repoId)
    if (result.summary) {
      setSummary(result.summary)
    }
    if (result.meta) {
      setMeta(result.meta)
    }
    if (result.error) {
      setError(result.error)
      setErrorCode(result.errorCode)
    }
    setLoading(false)
  }, [repoId])

  // Determine what to show
  const isCompleted = meta?.status === "completed" || initialStatus === "completed"
  const isFailed = meta?.status === "failed" || initialStatus === "failed"
  const isGenerated = isCompleted || summary

  // Button row — batchGenerating overrides
  const buttonLabel = batchGenerating
    ? t.library.generatingStatus
    : loading
      ? t.common.loading
      : isFailed
        ? t.library.failed
        : isGenerated
          ? expanded
            ? t.library.hideSummary
            : t.library.viewSummary
          : t.library.generateSummary

  const buttonIcon = batchGenerating || loading ? Loader2 : isFailed ? RotateCw : Sparkles

  const handleClick = batchGenerating || loading
    ? undefined
    : isFailed
      ? retry
      : isGenerated
        ? load
        : isCompleted && loaded
          ? () => setExpanded((p) => !p)
          : generate

  return (
    <div className="space-y-2">
      {/* Status + button row */}
      <div className="flex items-center gap-2 flex-wrap">
        {statusBadge(batchGenerating ? "running" : (meta?.status ?? (initialStatus as AnalysisMeta["status"])))}

        <button
          onClick={handleClick}
          disabled={loading || !handleClick}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {React.createElement(buttonIcon, {
            className: `size-3 ${loading || batchGenerating ? "animate-spin" : ""}`,
          })}
          {buttonLabel}
        </button>

        {isGenerated && loaded && (
          <button
            onClick={() => setExpanded((p) => !p)}
            className="text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertTriangle className="size-3" />
            {error}
          </div>
          {errorHint(errorCode) && (
            <p className="text-[11px] text-muted-foreground">{errorHint(errorCode)}</p>
          )}
        </div>
      )}

      {/* Summary display */}
      {isGenerated && expanded && summary && (
        <div className="rounded-md border bg-muted/30 p-3 space-y-3 text-sm">
          {/* Cache info */}
          {meta && isCompleted && (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                {formatDate(meta.cachedAt!)} {formatTime(meta.cachedAt!)}
              </span>
              {meta.model && (
                <span className="inline-flex items-center gap-1">
                  <Cpu className="size-3" />
                  {meta.model}
                </span>
              )}
              {meta.tokensUsed > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Hash className="size-3" />
                  {meta.tokensUsed.toLocaleString()} {t.analyses.tokens}
                </span>
              )}
              {meta.durationMs > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  {formatDuration(meta.durationMs)}
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-green-700">
                <CheckCircle2 className="size-3" />
                {t.library.cached}
              </span>
            </div>
          )}

          {/* One line — prominent */}
          <SummarySection label={t.dashboard.summary}>
            {summary.oneLine}
          </SummarySection>

          {/* Problem */}
          {summary.problem && summary.problem !== "不确定" && (
            <SummarySection label={t.library.problemSolved}>
              {summary.problem}
            </SummarySection>
          )}

          {/* Tech stack */}
          {summary.techStack.length > 0 && (
            <SummarySection label={t.library.techStack}>
              <span className="flex flex-wrap gap-1">
                {summary.techStack.map((tech) => (
                  <Badge key={tech} variant="secondary" className="text-[11px]">
                    {tech}
                  </Badge>
                ))}
              </span>
            </SummarySection>
          )}

          {/* Scenarios */}
          {summary.scenarios.length > 0 && (
            <SummarySection label={t.library.useCases}>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                {summary.scenarios.map((s, i) => (
                  <li key={i} className="text-[13px]">{s}</li>
                ))}
              </ul>
            </SummarySection>
          )}

          {/* Highlights */}
          {summary.highlights.length > 0 && (
            <SummarySection label={t.library.highlights}>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                {summary.highlights.map((h, i) => (
                  <li key={i} className="text-[13px]">{h}</li>
                ))}
              </ul>
            </SummarySection>
          )}

          {/* Learning value */}
          {summary.learningValue && summary.learningValue !== "不确定" && (
            <SummarySection label={t.library.learningValue}>
              <span className="text-muted-foreground">{summary.learningValue}</span>
            </SummarySection>
          )}

          {/* Reuse */}
          {summary.reuseSuggestion && summary.reuseSuggestion !== "不确定" && (
            <SummarySection label={t.library.howToReuse}>
              <span className="text-muted-foreground">{summary.reuseSuggestion}</span>
            </SummarySection>
          )}

          {/* Simple explanation */}
          {summary.simpleExplanation && (
            <SummarySection label={t.library.inPlainWords}>
              <span className="text-muted-foreground">{summary.simpleExplanation}</span>
            </SummarySection>
          )}
        </div>
      )}

      {/* Empty / Not generated */}
      {!isGenerated && expanded && !loading && !error && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t.library.clickToGenerate}
        </div>
      )}

      {/* Loading expanded */}
      {loading && expanded && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="size-3 animate-spin" />
          {t.library.generatingProgress}
        </div>
      )}
    </div>
  )
}
