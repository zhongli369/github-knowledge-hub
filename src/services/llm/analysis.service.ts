import { openai } from "@/lib/openai"
import { prisma } from "@/lib/prisma"
import { generateRepoEmbedding } from "@/services/llm/repo-embedding.service"

const PROMPT_VERSION = "repo-summary-v1"

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
  opts?: { analysisId?: string }
): Promise<{ summary: RepoSummary; cached: boolean }> {
  // ── Worker path: use existing record ──────────────────────────
  if (opts?.analysisId) {
    // Update the claimed record to "running"
    await prisma.analysis.update({
      where: { id: opts.analysisId },
      data: { status: "running", model: getModel() },
    })

    const summary = await executeRepoSummaryCall(repoMeta, readme)

    await prisma.analysis.update({
      where: { id: opts.analysisId },
      data: {
        status: "completed",
        result: JSON.parse(JSON.stringify({ summary, rawContent: summary.oneLine })),
      },
    })

    // Best-effort embedding generation
    tryEmbedding(repoId, userId)

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

  // 3. Create analysis record
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
    },
  })

  try {
    const summary = await executeRepoSummaryCall(repoMeta, readme)

    await prisma.analysis.update({
      where: { id: analysis.id },
      data: {
        status: "completed",
        result: JSON.parse(JSON.stringify({ summary, rawContent: summary.oneLine })),
      },
    })

    // Best-effort embedding generation
    tryEmbedding(repoId, userId)

    return { summary, cached: false }
  } catch (error) {
    if (error instanceof AnalysisError) {
      await prisma.analysis.update({
        where: { id: analysis.id },
        data: { status: "failed", error: error.message.slice(0, 1000) },
      })
      throw error
    }

    const errMsg = error instanceof Error ? error.message : "Unknown error"
    let code: AnalysisErrorCode = "LLM_CALL_FAILED"
    let userMsg = "LLM call failed. Please try again."

    if (error instanceof SyntaxError) {
      code = "LLM_JSON_PARSE_FAILED"
      userMsg = "LLM returned invalid JSON and could not be parsed."
    } else if (errMsg.includes("API key") || errMsg.includes("apiKey") || errMsg.includes("Incorrect API key")) {
      code = "API_KEY_MISSING"
      userMsg = "API key is invalid or missing. Check OPENAI_API_KEY in .env."
    }

    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { status: "failed", error: userMsg.slice(0, 1000) },
    })

    throw new AnalysisError(code, userMsg)
  }
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
): Promise<RepoSummary> {
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

  const response = await openai.chat.completions.create({
    model: getModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 2048,
  })

  const content = response.choices[0]?.message?.content ?? ""

  // Clean markdown code fences if present
  const jsonStr = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()

  return JSON.parse(jsonStr) as RepoSummary
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
      createdAt: true,
    },
  })

  if (!analysis) {
    return { status: "not_generated", summary: null, cachedAt: null, model: null, error: null }
  }

  const dbStatus = analysis.status as AnalysisStatus
  const result = analysis.result as Record<string, unknown> | null
  const summary = (result?.summary as RepoSummary) ?? null

  return {
    status: dbStatus,
    summary,
    cachedAt: analysis.createdAt.toISOString(),
    model: analysis.model ?? null,
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
    const response = await openai.chat.completions.create({
      model: getModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    })

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
    difficulty: "intermediate",
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function analyzeDependencies(_opts?: any): Promise<string> {
  throw new Error("analyzeDependencies is not implemented in Phase 7.0 MVP")
}
