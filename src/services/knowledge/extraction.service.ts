// TODO(Phase 5): Code → knowledge asset extraction with LLM — not yet wired into the main flow.
// Enable after repo/library E2E is verified.

import { prisma } from "@/lib/prisma"
import { analyzeCodePatterns } from "@/services/llm/analysis.service"
import { embedKnowledgeAsset } from "@/services/llm/embeddings.service"

// File extension → language mapping will be re-added when Phase 5 is enabled.

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

  try {
    const asset = await prisma.knowledgeAsset.create({
      data: {
        title: fileName,
        description: `LLM-analyzed ${language} code`,
        assetType: detectAssetType(path, content),
        sourcePath: path,
        content: content.slice(0, 50000),
        summary: analysis.slice(0, 2000),
        language,
        tags: extractTags(path, content),
        repositoryId,
        userId,
      },
    })

    try {
      await embedKnowledgeAsset(asset.id, `${fileName}\n${analysis}`)
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
 * Known limitation: does NOT check for existing assets — re-running on the same repo
 * will create duplicates. Deduplication is planned for Phase 7.1.
 */
export async function extractAssetsFromRepo(
  userId: string,
  repositoryId: string,
  owner: string,
  repoName: string,
  options?: { maxFiles?: number; useLLM?: boolean }
): Promise<{ extracted: number; skipped: number; embedded: number }> {
  const { fetchRepoFileTree, fetchFileContent } = await import("@/services/github")
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
