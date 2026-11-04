import { prisma } from "@/lib/prisma"
import { analyzeCodePatterns } from "@/services/llm/analysis.service"
import { embedKnowledgeAsset } from "@/services/llm/embeddings.service"

// File extension → language mapping will be re-added when Phase 5 is enabled.

export const ASSET_DIFFICULTIES = ["beginner", "intermediate", "advanced"] as const
export type AssetDifficulty = (typeof ASSET_DIFFICULTIES)[number]

const DIFFICULTY_SET: ReadonlySet<string> = new Set<string>(ASSET_DIFFICULTIES)

/**
 * Normalize a raw difficulty value to one of the allowed asset values.
 * Anything else (missing, empty, unknown, wrong language) maps to null so we
 * never fabricate a difficulty for legacy or malformed data.
 */
export function normalizeDifficulty(value: unknown): AssetDifficulty | null {
  return typeof value === "string" && DIFFICULTY_SET.has(value)
    ? (value as AssetDifficulty)
    : null
}

const INTERESTING_PATTERNS = [
  /algorithm/i,
  /pattern/i,
  /design/i,
  /architecture/i,
  /pipeline/i,
  /workflow/i,
  /optimization/i,
  /cache/i,
  /queue/i,
  /event.*(bus|driven)/i,
  /state.*machine/i,
  /strategy/i,
  /factory/i,
  /singleton/i,
  /observer/i,
  /decorator/i,
  /middleware/i,
  /plugin/i,
  /extension/i,
]

export interface ExtractionResult {
  assetId: string
  title: string
  assetType: string
}

export interface ParsedCodeAnalysis {
  /** Sanitized JSON summary, or null when the LLM payload is not valid JSON. */
  summary: string | null
  /** Validated difficulty, or null when the payload is missing/invalid. */
  difficulty: AssetDifficulty | null
}

/**
 * Validate and normalize the raw code-pattern analysis returned by
 * `analyzeCodePatterns`. Markdown code fences are stripped first; unparseable
 * payloads (or non-object shapes) yield entirely-null results so that garbage is
 * never persisted and difficulty is never fabricated.
 */
export function parseCodeAnalysisResult(raw: string): ParsedCodeAnalysis {
  const jsonStr = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { summary: null, difficulty: null }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { summary: null, difficulty: null }
  }

  const record = parsed as Record<string, unknown>
  return {
    summary: jsonStr.slice(0, 2000),
    difficulty: normalizeDifficulty(record.difficulty),
  }
}

export async function extractFromFile(
  userId: string,
  repositoryId: string,
  path: string,
  content: string,
  language: string
): Promise<ExtractionResult | null> {
  const fileName = path.split("/").pop() ?? path

  try {
    const asset = await prisma.knowledgeAsset.create({
      data: {
        title: `${fileName}`,
        description: `${language} file from repository`,
        assetType: detectAssetType(path, content),
        sourcePath: path,
        content: content.slice(0, 50000),
        language,
        tags: extractTags(path, content),
        difficulty: null,
        repositoryId,
        userId,
      },
    })

    try {
      await embedKnowledgeAsset(asset.id, content.slice(0, 8000))
    } catch {
      console.warn(`Failed to embed asset ${asset.id}`)
    }

    return {
      assetId: asset.id,
      title: asset.title,
      assetType: asset.assetType,
    }
  } catch (error) {
    const err = error as { code?: string }
    if (err.code === "P2002") {
      console.warn(`[extract] Duplicate asset skipped: ${path}`)
      return null
    }
    throw error
  }
}

export async function extractWithLLM(
  userId: string,
  repositoryId: string,
  path: string,
  content: string,
  language: string
): Promise<ExtractionResult | null> {
  const fileName = path.split("/").pop() ?? path

  // Skip files that are too long or too short
  if (content.length < 50 || content.length > 50000) return null
  if (!isInterestingFile(content)) return null

  const analysis = await analyzeCodePatterns({
    userId,
    repositoryId,
    content,
    fileName,
    language,
  })
  const parsed = parseCodeAnalysisResult(analysis)

  try {
    const asset = await prisma.knowledgeAsset.create({
      data: {
        title: fileName,
        description: `LLM-analyzed ${language} code`,
        assetType: detectAssetType(path, content),
        sourcePath: path,
        content: content.slice(0, 50000),
        summary: parsed.summary,
        difficulty: parsed.difficulty,
        language,
        tags: extractTags(path, content),
        repositoryId,
        userId,
      },
    })

    try {
      const embedText = parsed.summary ? `${fileName}\n${parsed.summary}` : fileName
      await embedKnowledgeAsset(asset.id, embedText)
    } catch {
      // best-effort
    }

    return {
      assetId: asset.id,
      title: asset.title,
      assetType: asset.assetType,
    }
  } catch (error) {
    const err = error as { code?: string }
    if (err.code === "P2002") {
      console.warn(`[extract] Duplicate asset skipped (LLM): ${path}`)
      return null
    }
    throw error
  }
}

function detectAssetType(path: string, content: string): string {
  const lower = path.toLowerCase()

  if (/\.(test|spec)\./.test(lower)) return "snippet"
  if (/algorithm|sort|search|hash|tree|graph|linked|queue|stack/i.test(content))
    return "algorithm"
  if (/design pattern|factory|singleton|observer|strategy|decorator/i.test(content))
    return "pattern"
  if (/dockerfile|docker-compose|\.ya?ml$|\.json$|\.toml$|\.env/i.test(lower))
    return "config"
  if (/architecture|middleware|pipeline|plugin|extension/i.test(content))
    return "architecture"
  if (/readme|\.md$|docs?\//i.test(lower)) return "doc"

  return "snippet"
}

function extractTags(path: string, content: string): string[] {
  const tags: Set<string> = new Set()
  const lower = path.toLowerCase()
  const combined = `${lower} ${content.slice(0, 2000).toLowerCase()}`

  const tagPatterns: [RegExp, string][] = [
    [/algorithm|sort|search|hash|tree|graph/i, "algorithm"],
    [/api|endpoint|route|handler|controller/i, "api"],
    [/database|sql|query|migration|schema|prisma/i, "database"],
    [/auth|oauth|jwt|session|token/i, "auth"],
    [/test|spec|mock|stub/i, "testing"],
    [/react|vue|angular|component|hook/i, "frontend"],
    [/docker|kubernetes|deploy|ci|cd/i, "devops"],
    [/queue|message|event|stream|pub.*sub/i, "messaging"],
    [/cache|redis|memcached/i, "caching"],
    [/log|monitor|metrics|trace|observ/i, "observability"],
    [/error|exception|retry|fallback/i, "error-handling"],
    [/config|setting|env|option/i, "configuration"],
    [/python|typescript|javascript|rust|go|java/i, "language"],
    [/machine.learning|ml|ai|neural|model|train/i, "ml-ai"],
  ]

  for (const [pattern, tag] of tagPatterns) {
    if (pattern.test(combined)) {
      tags.add(tag)
    }
  }

  return Array.from(tags).slice(0, 8)
}

function isInterestingFile(content: string): boolean {
  const combined = content.slice(0, 5000)
  return INTERESTING_PATTERNS.some((p) => p.test(combined))
}

// ── Orchestrator ─────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".rb": "Ruby",
  ".cs": "C#", ".cpp": "C++", ".c": "C", ".h": "C", ".swift": "Swift",
  ".kt": "Kotlin", ".scala": "Scala", ".sql": "SQL", ".sh": "Shell", ".bash": "Shell",
  ".yaml": "YAML", ".yml": "YAML", ".json": "JSON", ".toml": "TOML",
  ".md": "Markdown", ".mdx": "MDX", ".css": "CSS", ".scss": "SCSS",
  ".html": "HTML", ".vue": "Vue", ".svelte": "Svelte",
}

/**
 * Extract knowledge assets from a repository.
 *
 * Ownership is verified first: a user may only write assets into repositories
 * they own, so a caller can never inject assets into another user's repo.
 *
 * Re-runs are idempotent: paths already extracted for this repository are
 * skipped up-front, and the KnowledgeAsset(repositoryId, sourcePath) unique
 * index catches concurrent double-inserts (P2002) as a safety net.
 */
export async function extractAssetsFromRepo(
  userId: string,
  repositoryId: string,
  owner: string,
  repoName: string,
  options?: { maxFiles?: number; useLLM?: boolean }
): Promise<{ extracted: number; skipped: number; embedded: number }> {
  const { fetchRepoFileTree, fetchFileContent } = await import("@/services/github")

  // Permission boundary: refuse to write assets into a repo the caller does not own.
  const ownedRepo = await prisma.repository.findFirst({
    where: { id: repositoryId, userId },
    select: { id: true },
  })
  if (!ownedRepo) {
    throw new Error("Repository not found or not owned by this user")
  }

  const maxFiles = options?.maxFiles ?? 20
  const useLLM = options?.useLLM ?? true

  const tree = await fetchRepoFileTree(userId, owner, repoName)

  // Filter to files with known extensions, sort by size desc
  const files = tree
    .filter((f) => f.type === "file" && f.path)
    .map((f) => {
      const ext = f.path.slice(f.path.lastIndexOf(".")).toLowerCase()
      return { ...f, ext, lang: EXT_TO_LANG[ext] }
    })
    .filter((f) => f.lang)
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, maxFiles)

  // Pre-extraction dedup: skip files already extracted for this repo
  const existingPaths = new Set(
    (await prisma.knowledgeAsset.findMany({
      where: { repositoryId },
      select: { sourcePath: true },
    }))
      .map((a) => a.sourcePath)
      .filter(Boolean) as string[]
  )

  let extracted = 0
  let skipped = 0
  let embedded = 0

  for (const file of files) {
    if (existingPaths.has(file.path)) {
      skipped++
      continue
    }
    try {
      const content = await fetchFileContent(userId, owner, repoName, file.path)
      if (!content || content.length < 50) {
        skipped++
        continue
      }

      if (useLLM) {
        if (!isInterestingFile(content)) {
          skipped++
          continue
        }
        const result = await extractWithLLM(userId, repositoryId, file.path, content, file.lang)
        if (result) extracted++
        else skipped++
      } else {
        const result = await extractFromFile(userId, repositoryId, file.path, content, file.lang)
        if (result) extracted++
        else skipped++
      }

      // Embedding is best-effort inside extractFromFile/extractWithLLM
      embedded = extracted
    } catch {
      skipped++
    }
  }

  return { extracted, skipped, embedded }
}
