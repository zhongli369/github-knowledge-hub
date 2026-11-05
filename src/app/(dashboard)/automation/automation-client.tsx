"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Clock, Loader2, Play, RefreshCw, Save } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLanguage } from "@/i18n/LanguageProvider"
import {
  getAutomationDashboardAction,
  runAutomationNowAction,
  updateAutomationSettingsAction,
  type AutomationDashboardData,
  type AutomationDashboardResult,
  type SyncRunView,
} from "@/actions/automation"

/** Poll cadence while a sync is running. */
const POLL_MS = 10_000
/** Hard ceiling on consecutive polls while a run stays active. */
const MAX_POLLS = 240

const STRINGS: Record<
  "zh" | "en",
  Record<string, string>
> = {
  zh: {
    title: "自动化同步",
    description: "定时增量同步你的 GitHub 星标仓库，并在有新内容时自动排队 AI 分析。",
    enabled: "已启用",
    disabled: "已暂停",
    enableHint: "启用后，后台 worker 会按设定间隔自动运行星标仓库同步。",
    pause: "暂停",
    enable: "启用",
    autoAnalyze: "自动 AI 分析",
    autoAnalyzeHint: "同步时自动为新增或内容变更的仓库排队 AI 分析。",
    intervalLabel: "同步间隔",
    intervalHint: "15 – 10080 分钟（15 分钟 – 7 天），整数。",
    minutes: "分钟",
    save: "保存",
    runNow: "立即同步",
    syncInProgress: "同步中…",
    refresh: "刷新",
    nextSync: "下次同步",
    lastActive: "上次活跃",
    neverActive: "尚未同步",
    none: "—",
    progress: "进度",
    processedOf: "已处理 / 共",
    added: "新增",
    updated: "更新",
    unchanged: "未变",
    unstarred: "取消星标",
    failed: "失败",
    queuedAnalysis: "排队分析",
    recentRuns: "最近运行",
    noRunsYet: "暂无同步记录。点击「立即同步」或启用定时同步开始。",
    manual: "手动",
    scheduled: "定时",
    runningStatus: "运行中",
    completedStatus: "已完成",
    failedStatus: "失败",
    error: "错误",
    analysisQueueTitle: "AI 分析队列",
    analysisQueueHint: "当前与你相关的分析任务分布",
    pending: "待处理",
    running: "运行中",
    completed: "已完成",
    loadError: "加载失败",
    retry: "重试",
    alreadyRunning: "已有同步正在进行，本次请求已忽略。",
    invalidInterval: "请输入有效的整数分钟数（15 – 10080）。",
    polling: "同步进行中，页面将自动刷新…",
  },
  en: {
    title: "Automation",
    description:
      "Scheduled incremental sync of your starred GitHub repositories, with AI analysis automatically queued when content changes.",
    enabled: "Enabled",
    disabled: "Paused",
    enableHint:
      "When enabled, the background worker runs the starred-repo sync on a fixed interval.",
    pause: "Pause",
    enable: "Enable",
    autoAnalyze: "Auto AI analysis",
    autoAnalyzeHint:
      "Queue AI analysis for repositories that are new or whose content changed during a sync.",
    intervalLabel: "Sync interval",
    intervalHint: "15 – 10080 minutes (15 min – 7 days), whole numbers.",
    minutes: "min",
    save: "Save",
    runNow: "Sync now",
    syncInProgress: "Syncing…",
    refresh: "Refresh",
    nextSync: "Next sync",
    lastActive: "Last active",
    neverActive: "Never synced",
    none: "—",
    progress: "Progress",
    processedOf: "processed / total",
    added: "added",
    updated: "updated",
    unchanged: "unchanged",
    unstarred: "unstarred",
    failed: "failed",
    queuedAnalysis: "analyses queued",
    recentRuns: "Recent runs",
    noRunsYet: "No sync runs yet. Run a sync now or enable scheduling to start.",
    manual: "Manual",
    scheduled: "Scheduled",
    runningStatus: "Running",
    completedStatus: "Completed",
    failedStatus: "Failed",
    error: "Error",
    analysisQueueTitle: "AI analysis queue",
    analysisQueueHint: "Analysis tasks in the queue for you",
    pending: "pending",
    running: "running",
    completed: "completed",
    loadError: "Failed to load",
    retry: "Retry",
    alreadyRunning: "A sync is already running; this request was ignored.",
    invalidInterval: "Enter a valid whole number of minutes (15 – 10080).",
    polling: "Sync in progress — this page auto-refreshes…",
  },
}

function formatFullTime(iso: string | null, locale: "zh" | "en"): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function relativeLabel(iso: string | null, now: string): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  const nowMs = now ? new Date(now).getTime() : Date.now()
  const diffMs = Math.max(0, nowMs - then)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function progressPercent(run: SyncRunView): number {
  if (run.totalCount <= 0) return 0
  return Math.min(100, Math.round((run.processedCount / run.totalCount) * 100))
}

function statusBadge(run: SyncRunView | null, s: Record<string, string>) {
  if (!run) return null
  switch (run.status) {
    case "running":
      return <Badge className="bg-blue-100 text-blue-800">{s.runningStatus}</Badge>
    case "completed":
      return <Badge className="bg-green-100 text-green-800">{s.completedStatus}</Badge>
    case "failed":
      return <Badge variant="destructive">{s.failedStatus}</Badge>
    default:
      return <Badge variant="outline">{run.status}</Badge>
  }
}

interface Props {
  initial: AutomationDashboardResult
}

export function AutomationClient({ initial }: Props) {
  const { locale } = useLanguage()
  const s = STRINGS[locale]

  const [data, setData] = useState<AutomationDashboardData | null>(initial.ok ? initial.data : null)
  const [loadError, setLoadError] = useState<string | null>(initial.ok ? null : initial.error)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingSave, setPendingSave] = useState(false)
  const [pendingRun, setPendingRun] = useState(false)
  const [intervalInput, setIntervalInput] = useState<string>(
    initial.ok ? String(initial.data.settings.intervalMinutes) : "60"
  )

  // Keep the editable interval input in sync when settings arrive via refresh.
  useEffect(() => {
    if (data) setIntervalInput(String(data.settings.intervalMinutes))
  }, [data?.settings.intervalMinutes]) // eslint-disable-line react-hooks/exhaustive-deps

  const settings = data?.settings ?? null

  const refresh = useCallback(async () => {
    const res = await getAutomationDashboardAction()
    if (res.ok && res.data) {
      setData(res.data)
      setLoadError(null)
    } else {
      setLoadError(res.error ?? "Failed to load")
    }
  }, [])

  // Bounded polling while a sync run is active (running status in DB, or a
  // manual "sync now" is awaiting its long server action).
  const hasActiveRun = useMemo(() => {
    if (!data) return false
    return (
      data.latestRun?.status === "running" ||
      data.recentRuns.some((r) => r.status === "running") ||
      pendingRun
    )
  }, [data, pendingRun])

  const pollsRef = useRef(0)
  useEffect(() => {
    if (!hasActiveRun) {
      pollsRef.current = 0
      return
    }
    const timer = setInterval(() => {
      pollsRef.current += 1
      if (pollsRef.current > MAX_POLLS) {
        clearInterval(timer)
        return
      }
      void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [hasActiveRun, refresh])

  const applySettings = useCallback((settingsView: NonNullable<AutomationDashboardData["settings"]>) => {
    setData((d) => (d ? { ...d, settings: settingsView } : d))
    setIntervalInput(String(settingsView.intervalMinutes))
  }, [])

  const toggleEnabled = async () => {
    if (!settings || pendingSave) return
    setPendingSave(true)
    setActionError(null)
    try {
      const res = await updateAutomationSettingsAction({ enabled: !settings.enabled })
      if (res.ok && res.data) applySettings(res.data)
      else setActionError(res.error)
    } finally {
      setPendingSave(false)
    }
  }

  const toggleAutoAnalyze = async () => {
    if (!settings || pendingSave) return
    setPendingSave(true)
    setActionError(null)
    try {
      const res = await updateAutomationSettingsAction({ autoAnalyze: !settings.autoAnalyze })
      if (res.ok && res.data) applySettings(res.data)
      else setActionError(res.error)
    } finally {
      setPendingSave(false)
    }
  }

  const saveInterval = async () => {
    if (!settings || pendingSave) return
    const value = Number(intervalInput)
    if (!Number.isInteger(value)) {
      setActionError(s.invalidInterval)
      return
    }
    setPendingSave(true)
    setActionError(null)
    try {
      const res = await updateAutomationSettingsAction({ intervalMinutes: value })
      if (res.ok && res.data) applySettings(res.data)
      else setActionError(res.error)
    } finally {
      setPendingSave(false)
    }
  }

  const runNow = async () => {
    if (pendingRun) return
    setPendingRun(true)
    setActionError(null)
    try {
      const res = await runAutomationNowAction()
      if (res.alreadyRunning) {
        setActionError(s.alreadyRunning)
      } else if (!res.ok) {
        setActionError(res.error)
      }
      await refresh()
    } finally {
      setPendingRun(false)
    }
  }

  const latestRun = data?.latestRun ?? null
  const analysis = data?.analysisCounts

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{s.title}</h1>
          <p className="text-sm text-muted-foreground">{s.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pendingRun || pendingSave}
            onClick={runNow}
          >
            {pendingRun || latestRun?.status === "running" ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Play className="mr-2 size-4" />
            )}
            {pendingRun || latestRun?.status === "running" ? s.syncInProgress : s.runNow}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="mr-2 size-4" />
            {s.refresh}
          </Button>
        </div>
      </div>

      {hasActiveRun && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {s.polling}
        </p>
      )}

      {(loadError || actionError) && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {loadError ?? actionError}
          </span>
          {loadError && (
            <button
              onClick={() => void refresh()}
              className="text-xs underline underline-offset-2 hover:text-destructive/80"
            >
              {s.retry}
            </button>
          )}
        </div>
      )}

      {!data && loadError ? (
        <div className="flex flex-col items-center justify-center rounded-lg border p-12 text-center">
          <p className="text-sm text-muted-foreground">{loadError}</p>
        </div>
      ) : (
        <>
          {/* Settings */}
          <section className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  {settings?.enabled ? s.enabled : s.disabled}
                </p>
                <p className="text-xs text-muted-foreground">{s.enableHint}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-end text-xs text-muted-foreground">
                  <span>{s.nextSync}</span>
                  <span className="flex items-center gap-1 text-sm font-medium text-foreground">
                    <Clock className="size-3" />
                    {formatFullTime(settings?.nextSyncAt ?? null, locale)}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings?.enabled ?? false}
                  disabled={pendingSave}
                  onClick={toggleEnabled}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    settings?.enabled ? "bg-primary" : "bg-muted"
                  } ${pendingSave ? "opacity-60" : ""}`}
                >
                  <span
                    className={`inline-block size-4 rounded-full bg-background shadow transition-transform ${
                      settings?.enabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{s.autoAnalyze}</p>
                  <p className="text-xs text-muted-foreground">{s.autoAnalyzeHint}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings?.autoAnalyze ?? true}
                  disabled={pendingSave}
                  onClick={toggleAutoAnalyze}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    settings?.autoAnalyze ? "bg-primary" : "bg-muted"
                  } ${pendingSave ? "opacity-60" : ""}`}
                >
                  <span
                    className={`inline-block size-4 rounded-full bg-background shadow transition-transform ${
                      settings?.autoAnalyze ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label
                    htmlFor="automation-interval"
                    className="text-sm font-medium"
                  >
                    {s.intervalLabel} ({s.minutes})
                  </label>
                  <Input
                    id="automation-interval"
                    type="number"
                    min={15}
                    max={10080}
                    step={1}
                    value={intervalInput}
                    onChange={(e) => setIntervalInput(e.target.value)}
                    disabled={pendingSave}
                    className="mt-1"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{s.intervalHint}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pendingSave || !settings}
                  onClick={() => void saveInterval()}
                >
                  <Save className="mr-2 size-4" />
                  {s.save}
                </Button>
              </div>
            </div>
          </section>

          {/* Latest run */}
          <section className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{s.recentRuns}</h2>
                {statusBadge(latestRun, s)}
              </div>
              {latestRun && (
                <span className="text-xs text-muted-foreground">
                  {latestRun.trigger === "manual" ? s.manual : s.scheduled} ·{" "}
                  {formatFullTime(latestRun.startedAt, locale)} ·{" "}
                  <span className="capitalize">
                    {relativeLabel(latestRun.startedAt, data?.now ?? "")}
                  </span>
                </span>
              )}
            </div>

            {!latestRun ? (
              <p className="mt-3 text-sm text-muted-foreground">{s.noRunsYet}</p>
            ) : (
              <div className="mt-3 space-y-3">
                <div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{s.progress}</span>
                    <span>
                      {s.processedOf} {latestRun.processedCount} / {latestRun.totalCount}
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${progressPercent(latestRun)}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
                  <Stat
                    label={s.added}
                    value={latestRun.addedCount}
                    tone={latestRun.addedCount > 0 ? "positive" : "plain"}
                  />
                  <Stat
                    label={s.updated}
                    value={latestRun.updatedCount}
                    tone={latestRun.updatedCount > 0 ? "positive" : "plain"}
                  />
                  <Stat label={s.unchanged} value={latestRun.unchangedCount} />
                  <Stat label={s.unstarred} value={latestRun.unstarredCount} />
                  <Stat
                    label={s.failed}
                    value={latestRun.failedCount}
                    tone={latestRun.failedCount > 0 ? "danger" : "plain"}
                  />
                  <Stat
                    label={s.queuedAnalysis}
                    value={latestRun.analysisQueuedCount}
                    tone={latestRun.analysisQueuedCount > 0 ? "accent" : "plain"}
                  />
                </div>

                {(latestRun.status === "failed" || latestRun.failedCount > 0) && latestRun.error && (
                  <p className="rounded-md bg-destructive/5 px-2 py-1 text-xs text-muted-foreground">
                    {s.error}: {latestRun.error}
                  </p>
                )}
              </div>
            )}

            {data && data.recentRuns.length > 1 && (
              <ul className="mt-4 divide-y border-t">
                {data.recentRuns.slice(1).map((run) => (
                  <li key={run.id} className="flex items-center justify-between py-2 text-xs">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <StatusDot status={run.status} />
                      {run.trigger === "manual" ? s.manual : s.scheduled}
                      <span>{formatFullTime(run.startedAt, locale)}</span>
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span>
                        {run.processedCount}/{run.totalCount}
                      </span>
                      {run.status === "failed" && run.error && (
                        <AlertTriangle className="size-3 text-destructive" />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Analysis queue */}
          {analysis && (
            <section className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold">{s.analysisQueueTitle}</h2>
              <p className="text-xs text-muted-foreground">{s.analysisQueueHint}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label={s.pending} value={analysis.pending} tone={analysis.pending > 0 ? "accent" : "plain"} />
                <Stat label={s.running} value={analysis.running} tone={analysis.running > 0 ? "accent" : "plain"} />
                <Stat label={s.completed} value={analysis.completed} tone={analysis.completed > 0 ? "positive" : "plain"} />
                <Stat label={s.failed} value={analysis.failed} tone={analysis.failed > 0 ? "danger" : "plain"} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone = "plain",
}: {
  label: string
  value: number
  tone?: "plain" | "positive" | "danger" | "accent"
}) {
  const toneClass = {
    plain: "text-foreground",
    positive: "text-green-600",
    danger: "text-destructive",
    accent: "text-blue-600",
  }[tone]
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold leading-tight ${toneClass}`}>{value}</p>
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "bg-blue-500"
      : status === "completed"
        ? "bg-green-500"
        : status === "failed"
          ? "bg-destructive"
          : "bg-muted-foreground"
  return <span className={`inline-block size-2 rounded-full ${color}`} />
}