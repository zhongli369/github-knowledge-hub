import { prisma } from "@/lib/prisma"
import { analyzeCodePatterns } from "@/services/llm/analysis.service"
import { embedKnowledgeAsset } from "@/services/llm/embeddings.service"
import { createFileContentHash } from "@/services/analysis/content-fingerprint"

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

/**
 * Extra bookkeeping the P3 auto-sync passes down to every created asset so the
 * extraction layer can persist `sourceSha` / `contentHash` on the asset row.
 * Both are optional so legacy/manual callers are unaffected.
 */
export interface ExtractionAssetFingerprint {
  sourceSha?: string | null
  contentHash?: string | null
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
  language: string,
  fingerprint?: ExtractionAssetFingerprint
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
        sourceSha: fingerprint?.sourceSha ?? null,
        contentHash: fingerprint?.contentHash ?? null,
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
  language: string,
  isCancelled: () => boolean = () => false,
  fingerprint?: ExtractionAssetFingerprint
): Promise<ExtractionResult | null> {
  const fileName = path.split("/").pop() ?? path

  if (isCancelled()) return null

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
  if (isCancelled()) return null
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
        sourceSha: fingerprint?.sourceSha ?? null,
        contentHash: fingerprint?.contentHash ?? null,
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
 * Re-runs are idempotent: the KnowledgeAsset(repositoryId, sourcePath) unique
 * index catches concurrent double-inserts (P2002), and the worker never stacks
 * duplicate extractions.
 *
 * P3 — automatic incremental sync runs (recognised by the *presence* of a
 * `sourceSha` property in the options, even when its value is null) additionally:
 *   * skip unchanged files by comparing the file's SHA-256 with the asset's
 *     recorded `contentHash` (no LLM, no write);
 *   * backfill provenance (`sourceSha`/`contentHash`) on legacy assets whose
 *     stored content is byte-identical;
 *   * refresh a changed asset *in place* (same id, collections preserved) via
 *     `updateMany` — new source text and, when LLM-worthy, a fresh summary.
 *
 * Manual/legacy callers (no `sourceSha`) keep the original behaviour exactly:
 * previously-extracted paths are skipped up-front.
 */
export async function extractAssetsFromRepo(
  userId: string,
  repositoryId: string,
  owner: string,
  repoName: string,
  options?: {
    maxFiles?: number
    useLLM?: boolean
    isCancelled?: () => boolean
    /** Git snapshot this extraction was queued for (P3 auto-sync). */
    sourceSha?: string | null
  }
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
  const isCancelled = options?.isCancelled ?? (() => false)
  const sourceSha = options?.sourceSha ?? null
  // The P3 worker is the ONLY caller that sets the `sourceSha` property (see
  // workers/analysis-worker.ts): its *presence* — even with a null value, which
  // happens for an empty-repo / fingerprint-fallback snapshot — marks this run
  // as automatic. Manual/legacy callers omit the property entirely and keep the
  // P1/P2 path-based pre-dedup.
  const isAutomatic =
    options !== undefined && Object.prototype.hasOwnProperty.call(options, "sourceSha")

  if (isCancelled()) return { extracted: 0, skipped: 0, embedded: 0 }

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

  // Pre-extraction dedup state.
  //
  // * `existingByPath` maps sourcePath → the previously-created asset for this
  //   repository (id + optional contentHash + optional stored content).
  // * A `contentHash` of null marks a *legacy* (pre-P3) asset whose fingerprint
  //   was never recorded; it never re-fetches on the manual path.
  // * `isAutomatic` is derived from an explicit `sourceSha` in the options (the
  //   GitHub sync always passes one). Manual/legacy callers omit it and keep
  //   the historical path-based behaviour.
  const existingByPath = new Map<string, { id: string; contentHash: string | null; storedContent: string | null }>()
  const priorAssets = await prisma.knowledgeAsset.findMany({
    where: { repositoryId },
    select: { id: true, sourcePath: true, contentHash: true },
  })
  for (const asset of priorAssets) {
    if (!asset.sourcePath || existingByPath.has(asset.sourcePath)) continue
    existingByPath.set(asset.sourcePath, {
      id: asset.id,
      contentHash: asset.contentHash ?? null,
      storedContent: null,
    })
  }

  // Automatic runs can compute the "old" fingerprint of a legacy asset from the
  // content the asset already stores, so a byte-identical legacy file is
  // backfilled with provenance instead of being re-analyzed. Fetch that content
  // once, only for the legacy paths actually present in this repository.
  if (isAutomatic) {
    const legacyPaths = Array.from(existingByPath.entries())
      .filter(([, prior]) => prior.contentHash == null)
      .map(([sourcePath]) => sourcePath)
    if (legacyPaths.length > 0) {
      const legacyRows = await prisma.knowledgeAsset.findMany({
        where: { repositoryId, sourcePath: { in: legacyPaths }, contentHash: null },
        select: { sourcePath: true, content: true },
      })
      for (const row of legacyRows) {
        if (!row.sourcePath) continue
        const prior = existingByPath.get(row.sourcePath)
        if (prior) prior.storedContent = row.content ?? null
      }
    }
  }

  let extracted = 0
  let skipped = 0
  let embedded = 0

  for (const file of files) {
    if (isCancelled()) break

    const prior = existingByPath.get(file.path)
    const prevHash = prior?.contentHash ?? null

    // Manual/legacy runs (no sourceSha) keep the P1/P2 pre-dedup: any prior
    // asset for this path is left untouched (no fetch, no LLM, no write).
    if (!isAutomatic && prior) {
      skipped++
      continue
    }

    let content: string | null
    try {
      content = await fetchFileContent(userId, owner, repoName, file.path)
    } catch (error) {
      if (isCancelled()) break
      // Rate limits, permission failures and other upstream errors must fail the
      // Analysis so the worker can retry; they are not ordinary file skips.
      throw error
    }
    if (isCancelled()) break
    if (!content || content.length < 50) {
      skipped++
      continue
    }

    const contentHash = createFileContentHash(content)

    // ── Brand-new path: extract a fresh knowledge asset ──
    if (!prior) {
      if (useLLM) {
        if (!isInterestingFile(content)) {
          skipped++
          continue
        }
        const result = await extractWithLLM(
          userId,
          repositoryId,
          file.path,
          content,
          file.lang,
          isCancelled,
          { sourceSha, contentHash },
        )
        if (result) {
          extracted++
          existingByPath.set(file.path, {
            id: result.assetId,
            contentHash,
            storedContent: content.slice(0, 50000),
          })
        } else {
          skipped++
        }
      } else {
        const result = await extractFromFile(userId, repositoryId, file.path, content, file.lang, {
          sourceSha,
          contentHash,
        })
        if (result) {
          extracted++
          existingByPath.set(file.path, {
            id: result.assetId,
            contentHash,
            storedContent: content.slice(0, 50000),
          })
        } else {
          skipped++
        }
      }
      continue
    }

    // ── An asset already exists for this sourcePath (automatic runs only) ──

    // The same (repositoryId, sourcePath) already holds a knowledge asset whose
    // content hash is identical: content is unchanged — skip the LLM call (and
    // any write) entirely. This is the P3 auto-sync dedup core.
    if (prevHash !== null && prevHash === contentHash) {
      skipped++
      continue
    }

    // Legacy provenance backfill: a legacy asset (contentHash null) whose stored
    // content is byte-identical to the current file only needs sourceSha /
    // contentHash recorded — its summary and content stay untouched.
    const oldHash = prior.storedContent ? createFileContentHash(prior.storedContent) : null
    if (prevHash === null && oldHash === contentHash) {
      const updated = await prisma.knowledgeAsset.updateMany({
        where: { id: prior.id, repositoryId, sourcePath: file.path, contentHash: null },
        data: { sourceSha, contentHash },
      })
      if (updated.count > 0) {
        existingByPath.set(file.path, { id: prior.id, contentHash, storedContent: prior.storedContent })
      }
      skipped++
      continue
    }

    // Content changed (or a legacy stored content differs / is unavailable):
    // refresh the EXISTING asset in place — same id, collections preserved —
    // with the new source text and, when the file is LLM-worthy, a fresh
    // summary. Fenced on the old contentHash so a concurrent refresh of the same
    // row loses this update instead of clobbering a newer result.
    let freshSummary: string | null
    let freshDifficulty: AssetDifficulty | null = null
    if (useLLM && isInterestingFile(content)) {
      const analysis = await analyzeCodePatterns({
        userId,
        repositoryId,
        content,
        fileName: file.path.split("/").pop() ?? file.path,
        language: file.lang,
      })
      if (isCancelled()) break
      const parsed = parseCodeAnalysisResult(analysis)
      freshSummary = parsed.summary
      freshDifficulty = parsed.difficulty
    } else {
      // Not LLM-worthy (or plain extraction): sync content + provenance and
      // clear any stale summary/difficulty — an old description pasted over the
      // new content would be misleading.
      freshSummary = null
    }

    const updated = await prisma.knowledgeAsset.updateMany({
      where: { id: prior.id, repositoryId, sourcePath: file.path, contentHash: prevHash },
      data: {
        content: content.slice(0, 50000),
        description: `${file.lang} file from repository`,
        assetType: detectAssetType(file.path, content),
        language: file.lang,
        tags: extractTags(file.path, content),
        summary: freshSummary,
        difficulty: freshSummary !== null ? freshDifficulty : null,
        sourceSha,
        contentHash,
      },
    })
    if (updated.count === 0) {
      // A concurrent run refreshed the row between our fetch and this update
      // (the WHERE clause no longer matches). Count as already handled.
      skipped++
      continue
    }
    existingByPath.set(file.path, { id: prior.id, contentHash, storedContent: content.slice(0, 50000) })
    extracted++

    // Best-effort re-embed under the new summary / content.
    const embedText = freshSummary ? `${file.path.split("/").pop() ?? ""}\n${freshSummary}` : content
    try {
      await embedKnowledgeAsset(prior.id, embedText.slice(0, 8000))
    } catch {
      // best-effort — a refresh must not fail because embedding is down
    }
  }

  // Embedding is best-effort inside extractFromFile/extractWithLLM/refresh.
  embedded = extracted

  return { extracted, skipped, embedded }
}
