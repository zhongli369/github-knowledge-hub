import { openai } from "@/lib/openai"
import { prisma } from "@/lib/prisma"
import { generateRepoEmbedding } from "@/services/llm/repo-embedding.service"
import { completeAnalysis } from "@/services/analysis/leasing.service"
import {
  extractTokenUsage,
  isRetryableLLMError,
  withRetry,
  LLM_MAX_RETRIES,
  type AnalysisMetrics,
  type OpenAICompletionResponseLike,
} from "@/services/llm/llm-telemetry"

type RepoSummaryLLMResponse = OpenAICompletionResponseLike & {
  choices?: Array<{ message?: { content?: string | null } }>
}

const PROMPT_VERSION = "repo-summary-v1"
const DIRECT_ANALYSIS_WORKER_ID = "direct:server-action"
const DIRECT_ANALYSIS_LEASE_MS = 10 * 60_000
const DIRECT_ANALYSIS_FENCING_TOKEN = 0

function getModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini"
}

// ── Structured summary output ───────────────────────────────────

export interface RepoSummary {
  oneLine: string
  problem: string
  techStack: string[]
  scenarios: string[]
  highlights: string[]
  learningValue: string
  reuseSuggestion: string
  simpleExplanation: string
}

// ── Core: check cache, call LLM, save result ────────────────────

export async function analyzeRepoSummary(
  repoId: string,
  userId: string,
  repoMeta: {
    name: string
    fullName: string
    description: string | null
    language: string | null
    topics: string[]
    stars: number
    forks: number
    url: string
    defaultBranch: string
  },
  readme: string | null,
  opts?: {
    analysisId?: string
    workerId?: string
    fencingToken?: number
    canWrite?: () => boolean
  }
): Promise<{ summary: RepoSummary; cached: boolean }> {
  // ── Worker path: use existing claimed record ──────────────────
  if (opts?.analysisId) {
    // The worker path must always carry the owning worker identity so the
    // terminal update stays conditional on a valid lease; a stale worker can
    // never overwrite a newer worker's result. Only the leasing worker calls
    // this path with a workerId.
    if (!opts.workerId || opts.fencingToken == null) {
      throw new AnalysisError("UNKNOWN", "Worker analysis requires a worker identity and fencing token")
    }

    let summary: RepoSummary
    let metrics: AnalysisMetrics
    try {
      ;({ summary, metrics } = await executeRepoSummaryCall(repoMeta, readme))
    } catch (error) {
      throw error instanceof AnalysisError ? error : normalizeAnalysisError(error)
    }

    // A heartbeat/timeout may have invalidated the claim while the LLM call was
    // in flight. Do not even attempt a terminal write after that point.
    if (opts.canWrite && !opts.canWrite()) {
      return { summary, cached: false }
    }

    const completed = await completeAnalysis({
      analysisId: opts.analysisId,
      workerId: opts.workerId,
      fencingToken: opts.fencingToken,
      status: "completed",
      result: JSON.parse(JSON.stringify({ summary, rawContent: summary.oneLine })),
      model: getModel(),
      tokensUsed: metrics.tokensUsed ?? 0,
      durationMs: metrics.durationMs,
    })

    if (completed) {
      // Best-effort embedding generation, only while we still own the task.
      tryEmbedding(repoId, userId)
    } else {
      console.warn(`[worker] Lost lease for ${opts.analysisId}; repo summary result discarded`)
    }

    return { summary, cached: false }
  }

  // ── Direct path: cache check + create new record ──────────────
  // 1. Check cache — existing completed summary
  const existing = await prisma.analysis.findFirst({
    where: {
      repositoryId: repoId,
      userId,
      analysisType: "repo_summary",
      status: "completed",
    },
    orderBy: { createdAt: "desc" },
  })

  if (existing?.result) {
    const result = existing.result as Record<string, unknown>
    if (result.summary) {
      return { summary: result.summary as RepoSummary, cached: true }
    }
  }

  // 2. Validate API key
  if (!process.env.OPENAI_API_KEY) {
    throw new AnalysisError(
      "API_KEY_MISSING",
      "OPENAI_API_KEY is not configured. Set it in .env to enable AI analysis."
    )
  }

  // 3. Create analysis record. Direct Server Actions do not heartbeat, so use
  // a finite recovery lease: a live request is not immediately reclaimed as a
  // NULL-lease crash, while a genuinely crashed request becomes recoverable.
  const claimedAt = new Date()
  const analysis = await prisma.analysis.create({
    data: {
      analysisType: "repo_summary",
      status: "running",
      model: getModel(),
      input: {
        repoName: repoMeta.fullName,
        language: repoMeta.language,
        promptVersion: PROMPT_VERSION,
      },
      repositoryId: repoId,
      userId,
      workerId: DIRECT_ANALYSIS_WORKER_ID,
      attempts: DIRECT_ANALYSIS_FENCING_TOKEN,
      claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + DIRECT_ANALYSIS_LEASE_MS),
    },
  })

  const directClaim = () => ({
    id: analysis.id,
    status: "running",
    workerId: DIRECT_ANALYSIS_WORKER_ID,
    attempts: DIRECT_ANALYSIS_FENCING_TOKEN,
    leaseExpiresAt: { gt: new Date() },
  })
  const overallStartedAt = Date.now()

  try {
    const { summary, metrics } = await executeRepoSummaryCall(repoMeta, readme)

    // The attempts value fences this direct execution. If its lease expired and
    // a worker reclaimed the row, attempts changed and this stale request must
    // not overwrite or clear the replacement worker's claim/result.
    const completed = await prisma.analysis.updateMany({
      where: directClaim(),
      data: {
        status: "completed",
        result: JSON.parse(JSON.stringify({ summary, rawContent: summary.oneLine })),
        tokensUsed: metrics.tokensUsed ?? 0,
        durationMs: metrics.durationMs,
        workerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    })

    if (completed.count === 1) {
      // Best-effort embedding generation, only if this execution still owns the row.
      tryEmbedding(repoId, userId)
    } else {
      console.warn(`[direct] Lost lease for ${analysis.id}; repo summary result discarded`)
    }

    return { summary, cached: false }
  } catch (error) {
    const analysisError = error instanceof AnalysisError ? error : normalizeAnalysisError(error)
    // Preserve the precise LLM-call duration when available; otherwise fall
    // back to the wall time we spent in this block so failed tasks still carry
    // a meaningful durationMs.
    analysisError.durationMs ??= Math.max(0, Date.now() - overallStartedAt)
    await prisma.analysis.updateMany({
      where: directClaim(),
      data: {
        status: "failed",
        error: analysisError.message.slice(0, 1000),
        durationMs: analysisError.durationMs,
        workerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    })
    throw analysisError
  }
}

function normalizeAnalysisError(error: unknown): AnalysisError {
  if (error instanceof AnalysisError) return error

  const errMsg = error instanceof Error ? error.message : "Unknown error"
  if (error instanceof SyntaxError) {
    return new AnalysisError(
      "LLM_JSON_PARSE_FAILED",
      "LLM returned invalid JSON and could not be parsed.",
    )
  }
  if (errMsg.includes("API key") || errMsg.includes("apiKey") || errMsg.includes("Incorrect API key")) {
    return new AnalysisError(
      "API_KEY_MISSING",
      "API key is invalid or missing. Check OPENAI_API_KEY in .env.",
    )
  }
  return new AnalysisError("LLM_CALL_FAILED", "LLM call failed. Please try again.")
}

// ── Best-effort embedding helper ────────────────────────────────

function tryEmbedding(repoId: string, userId: string) {
  generateRepoEmbedding(repoId, userId).catch((err) => {
    console.warn("[embedding] Failed to generate repo embedding:", (err as Error).message)
  })
}

// ── Core LLM call (shared by direct and worker paths) ─────────────

async function executeRepoSummaryCall(
  repoMeta: {
    name: string
    fullName: string
    description: string | null
    language: string | null
    topics: string[]
    stars: number
    forks: number
    url: string
    defaultBranch: string
  },
  readme: string | null,
  lang: "zh" | "en" = "zh"
): Promise<{ summary: RepoSummary; metrics: AnalysisMetrics }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new AnalysisError(
      "API_KEY_MISSING",
      "OPENAI_API_KEY is not configured. Set it in .env to enable AI analysis."
    )
  }

  const zh = lang === "zh"

  const systemPrompt = zh
    ? [
        "你是一个资深软件工程师，负责分析 GitHub 仓库。",
        "你只能根据提供的 README 内容和仓库元数据来回答。",
        "如果你不确定某项信息，请写「不确定」，不要编造。",
        "你必须只输出 JSON，不要输出其他任何内容。",
        "请用中文输出所有字段。",
      ].join("\n")
    : [
        "You are a senior software engineer analyzing GitHub repositories.",
        "Answer based only on the provided README content and repository metadata.",
        "If you are unsure, write 'uncertain' — do not fabricate.",
        "Output ONLY JSON, nothing else.",
      ].join("\n")

  const metadataBlock = zh
    ? [
        `仓库名称：${repoMeta.fullName}`,
        `描述：${repoMeta.description || "无"}`,
        `语言：${repoMeta.language || "未知"}`,
        `主题标签：${repoMeta.topics.length > 0 ? repoMeta.topics.join("、") : "无"}`,
        `Star 数：${repoMeta.stars}`,
        `Fork 数：${repoMeta.forks}`,
        `默认分支：${repoMeta.defaultBranch}`,
      ].join("\n")
    : [
        `Repository: ${repoMeta.fullName}`,
        `Description: ${repoMeta.description || "N/A"}`,
        `Language: ${repoMeta.language || "Unknown"}`,
        `Topics: ${repoMeta.topics.length > 0 ? repoMeta.topics.join(", ") : "None"}`,
        `Stars: ${repoMeta.stars}`,
        `Forks: ${repoMeta.forks}`,
        `Default branch: ${repoMeta.defaultBranch}`,
      ].join("\n")

  const readmeLabel = zh ? "README 内容" : "README Content"
  const readmeFallback = zh ? "README：未提供" : "README: not provided"
  const readmeBlock = readme
    ? `${readmeLabel}：\n${readme.slice(0, 8000)}`
    : readmeFallback

  const userPrompt = zh
    ? [
        "请分析以下 GitHub 仓库：",
        "",
        "【仓库元数据】",
        metadataBlock,
        "",
        `【${readmeBlock}】`,
        "",
        "请输出以下 JSON 格式（所有字段用中文）：",
        "{",
        '  "oneLine": "一句话说明这个仓库做什么",',
        '  "problem": "它解决什么问题",',
        '  "techStack": ["技术栈列表"],',
        '  "scenarios": ["适用场景"],',
        '  "highlights": ["值得关注的亮点"],',
        '  "learningValue": "对开发者有什么学习价值",',
        '  "reuseSuggestion": "在个人项目中可以如何复用它的思路或代码",',
        '  "simpleExplanation": "用简单易懂的口语解释这个项目是什么，像给朋友介绍一样"',
        "}",
      ].join("\n")
    : [
        "Analyze the following GitHub repository:",
        "",
        "[Repository Metadata]",
        metadataBlock,
        "",
        `[${readmeBlock}]`,
        "",
        "Output the following JSON format:",
        "{",
        '  "oneLine": "A one-sentence summary of what this repo does",',
        '  "problem": "What problem it solves",',
        '  "techStack": ["List of technologies used"],',
        '  "scenarios": ["When to use this"],',
        '  "highlights": ["Notable features or design choices"],',
        '  "learningValue": "What developers can learn from this codebase",',
        '  "reuseSuggestion": "How to reuse ideas or code from this project",',
        '  "simpleExplanation": "Explain this project in plain English, like you would to a friend"',
        "}",
      ].join("\n")

  const startedAt = Date.now()

  // Transient failures (rate limits, 5xx, network) are retried with bounded
  // backoff; deterministic failures (invalid key, bad request) surface
  // immediately.
  let response: RepoSummaryLLMResponse
  try {
    response = await withRetry(
      () =>
        openai.chat.completions.create({
          model: getModel(),
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        }),
      {
        maxRetries: LLM_MAX_RETRIES,
        isRetryable: isRetryableLLMError,
        onRetry: (err, attempt) => {
          console.warn(
            `[llm] Retrying repo summary call (${attempt}/${LLM_MAX_RETRIES}):`,
            (err as Error).message
          )
        },
      }
    )
  } catch (error) {
    const analysisError = normalizeAnalysisError(error)
    analysisError.durationMs = Date.now() - startedAt
    throw analysisError
  }

  const durationMs = Date.now() - startedAt
  const tokensUsed = extractTokenUsage(response)

  const content = response.choices?.[0]?.message?.content ?? ""

  // Clean markdown code fences if present
  const jsonStr = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()

  let summary: RepoSummary
  try {
    summary = JSON.parse(jsonStr) as RepoSummary
  } catch (error) {
    const analysisError = normalizeAnalysisError(error)
    analysisError.durationMs = durationMs
    throw analysisError
  }

  return { summary, metrics: { durationMs, tokensUsed } }
}

// ── Error types ─────────────────────────────────────────────────

export type AnalysisErrorCode =
  | "API_KEY_MISSING"
  | "README_FETCH_FAILED"
  | "LLM_JSON_PARSE_FAILED"
  | "LLM_CALL_FAILED"
  | "NOT_AUTHENTICATED"
  | "REPO_NOT_FOUND"
  | "UNKNOWN"

export class AnalysisError extends Error {
  code: AnalysisErrorCode
  /** Wall-clock ms of the failing LLM call when it was measured. */
  durationMs?: number
  constructor(code: AnalysisErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "AnalysisError"
  }
}

// ── Status query ────────────────────────────────────────────────

export type AnalysisStatus = "not_generated" | "pending" | "running" | "completed" | "failed"

export interface AnalysisMeta {
  status: AnalysisStatus
  summary: RepoSummary | null
  cachedAt: string | null
  model: string | null
  tokensUsed: number
  durationMs: number
  error: string | null
}

export async function getRepoAnalysisStatus(repoId: string, userId: string): Promise<AnalysisMeta> {
  const analysis = await prisma.analysis.findFirst({
    where: {
      repositoryId: repoId,
      userId,
      analysisType: "repo_summary",
    },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      result: true,
      error: true,
      model: true,
      tokensUsed: true,
      durationMs: true,
      createdAt: true,
    },
  })

  if (!analysis) {
    return {
      status: "not_generated",
      summary: null,
      cachedAt: null,
      model: null,
      tokensUsed: 0,
      durationMs: 0,
      error: null,
    }
  }

  const dbStatus = analysis.status as AnalysisStatus
  const result = analysis.result as Record<string, unknown> | null
  const summary = (result?.summary as RepoSummary) ?? null

  return {
    status: dbStatus,
    summary,
    cachedAt: analysis.createdAt.toISOString(),
    model: analysis.model ?? null,
    tokensUsed: analysis.tokensUsed,
    durationMs: analysis.durationMs,
    error: analysis.error ?? null,
  }
}

// ── Retry ───────────────────────────────────────────────────────

export async function retryFailedAnalysis(
  repoId: string,
  userId: string,
  repoMeta: {
    name: string
    fullName: string
    description: string | null
    language: string | null
    topics: string[]
    stars: number
    forks: number
    url: string
    defaultBranch: string
  },
  readme: string | null
): Promise<{ summary: RepoSummary }> {
  // Only retry if latest is failed
  const latest = await prisma.analysis.findFirst({
    where: { repositoryId: repoId, userId, analysisType: "repo_summary" },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  })

  if (latest?.status !== "failed") {
    throw new AnalysisError("UNKNOWN", "Only failed analyses can be retried")
  }

  // Delete the failed record so cache check passes
  await prisma.analysis.deleteMany({
    where: { repositoryId: repoId, userId, analysisType: "repo_summary", status: "failed" },
  })

  return analyzeRepoSummary(repoId, userId, repoMeta, readme)
}

// ── Completed query ─────────────────────────────────────────────

export async function getRepoAnalysis(repoId: string, userId: string) {
  return prisma.analysis.findFirst({
    where: {
      repositoryId: repoId,
      userId,
      analysisType: "repo_summary",
      status: "completed",
    },
    orderBy: { createdAt: "desc" },
  })
}

export async function getUserAnalyses(userId: string) {
  return prisma.analysis.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      repository: {
        select: { id: true, fullName: true },
      },
    },
  })
}

// ── Code pattern analysis ────────────────────────────────────────

interface AnalyzeCodeOpts {
  userId: string
  repositoryId: string
  content: string
  fileName: string
  language: string
  lang?: "zh" | "en"
}

export async function analyzeCodePatterns(opts: AnalyzeCodeOpts): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackResult(opts.fileName)
  }

  const zh = (opts.lang ?? "zh") === "zh"

  const systemPrompt = zh
    ? [
        "你是一个资深软件工程师，负责分析代码文件中的可复用模式。",
        "你只能根据提供的代码内容来回答。",
        "如果你不确定某项信息，请写「不确定」，不要编造。",
        "你必须只输出 JSON，不要输出其他任何内容。",
        "请用中文输出所有字段。",
      ].join("\n")
    : [
        "You are a senior software engineer analyzing code files for reusable patterns.",
        "Answer based only on the provided code content.",
        "If you are unsure, write 'uncertain' — do not fabricate.",
        "Output ONLY JSON, nothing else.",
      ].join("\n")

  const userPrompt = zh
    ? [
        "请分析以下代码文件：",
        "",
        "【文件信息】",
        `文件名：${opts.fileName}`,
        `语言：${opts.language}`,
        "",
        "【代码内容】",
        opts.content.slice(0, 8000),
        "",
        "请输出以下 JSON 格式（所有字段用中文）：",
        "{",
        '  "patternName": "这个文件包含的设计模式或算法名称",',
        '  "whatItDoes": "这段代码做什么，用简单的话解释",',
        '  "reuseValue": "在个人项目中可以如何复用这段代码的思路",',
        '  "keyInsight": "这段代码中最值得学习的一个技术点",',
        '  "difficulty": "beginner / intermediate / advanced"',
        "}",
      ].join("\n")
    : [
        "Analyze the following code file:",
        "",
        "[File Info]",
        `File name: ${opts.fileName}`,
        `Language: ${opts.language}`,
        "",
        "[Code Content]",
        opts.content.slice(0, 8000),
        "",
        "Output the following JSON format:",
        "{",
        '  "patternName": "The design pattern or algorithm name in this file",',
        '  "whatItDoes": "What this code does, explained simply",',
        '  "reuseValue": "How this code\'s approach can be reused in personal projects",',
        '  "keyInsight": "The single most valuable technical insight in this code",',
        '  "difficulty": "beginner / intermediate / advanced"',
        "}",
      ].join("\n")

  try {
    const response = await withRetry(
      () =>
        openai.chat.completions.create({
          model: getModel(),
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 1024,
        }),
      {
        maxRetries: LLM_MAX_RETRIES,
        isRetryable: isRetryableLLMError,
        onRetry: (err, attempt) => {
          console.warn(
            `[llm] Retrying code pattern analysis (${attempt}/${LLM_MAX_RETRIES}):`,
            (err as Error).message
          )
        },
      }
    )

    const content = response.choices[0]?.message?.content ?? ""
    const jsonStr = content
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim()

    JSON.parse(jsonStr) // validate JSON
    return jsonStr
  } catch {
    return fallbackResult(opts.fileName)
  }
}

function fallbackResult(fileName: string): string {
  return JSON.stringify({
    patternName: fileName,
    whatItDoes: "LLM parse failed — retry or check manually",
    reuseValue: "",
    keyInsight: "",
    // Empty (not "intermediate") so the extraction layer maps it to an unknown
    // difficulty instead of fabricating a value for a failed LLM call.
    difficulty: "",
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function analyzeDependencies(_opts?: any): Promise<string> {
  // Kept for a future compatibility signature; the stub currently makes no use
  // of its inputs.
  void _opts
  throw new Error("analyzeDependencies is not implemented in Phase 7.0 MVP")
}
