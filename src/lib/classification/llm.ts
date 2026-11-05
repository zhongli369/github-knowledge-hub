/**
 * LLM 分类兜底。
 *
 * 仅当确定性规则未命中且存在最低限度的内容信号时才调用。LLM 只被允许返回
 * 固定 slug 数组（可多分类、去重）及可选的 confidence/reason；未知 slug 一律
 * 拒绝（`normalizeCategorySlugs` 丢弃），「other 不与具体分类并列」也在其中
 * 处理。结构化校验用 zod 完成。
 */

import { z } from "zod"
import { openai } from "@/lib/openai"
import {
  withRetry,
  isRetryableLLMError,
  extractTokenUsage,
  LLM_MAX_RETRIES,
  type AnalysisMetrics,
} from "@/services/llm/llm-telemetry"
import {
  normalizeCategorySlugs,
  slugFromCategoryName,
  REPO_CATEGORY_DEFINITIONS,
  type RepoCategorySlug,
} from "./taxonomy"

export class ClassificationLLMError extends Error {
  constructor(
    message: string,
    public readonly code: "MISSING_API_KEY" | "PARSING_FAILED" | "CALL_FAILED" = "CALL_FAILED"
  ) {
    super(message)
    this.name = "ClassificationLLMError"
  }
}

export interface LLMClassificationResult {
  categorySlugs: RepoCategorySlug[]
  confidence?: number
  reason?: string
}

export interface LLMClassificationContext {
  fullName: string
  description: string | null
  language: string | null
  topics: string[]
  stars: number
  summaryText: string | null
  readmeText: string | null
}

// LLM 返回结构：允许 categorySlugs 或 category_slugs 两种 key。
// zod 校验保证是对象、confidence 是 0..1、reason 是字符串；未知 key 被剥离。
// 注意：zod 3 的 z.object 默认剥离未知 key（等价于 zod4 的 loose）。
const objectSchema = z
  .object({
    categorySlugs: z.array(z.string()).optional(),
    category_slugs: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
  })

export type ParsedClassification =
  | { ok: true; categories: RepoCategorySlug[]; confidence?: number; reason?: string }
  | { ok: false; error: string }

/**
 * 解析 LLM 原始输出（可能是 JSON 对象或裸数组）。
 * - 未知 slug / 非法 slug 全部丢弃。
 * - 如果 LLM 返回的是类别名称（中/英文），用别名表映射回 slug。
 * - 「other 与具体分类并列」时丢弃 other。
 */
export function parseLLMClassification(raw: string): ParsedClassification {
  const jsonStr = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return { ok: false, error: "invalid-json" }
  }

  // 裸数组形态：["ai-llm-agent", "learning"]
  if (Array.isArray(parsed)) {
    return { ok: true, categories: normalizeRawSlugs(parsed) }
  }

  const parsedObject = objectSchema.safeParse(parsed)
  if (!parsedObject.success) {
    return { ok: false, error: "unexpected-shape" }
  }

  const data = parsedObject.data
  let rawSlugs: unknown[] = data.categorySlugs ?? data.category_slugs ?? []
  if (!Array.isArray(rawSlugs)) rawSlugs = [rawSlugs]
  const confidence = data.confidence
  const reason = data.reason?.trim() ? data.reason.slice(0, 500) : undefined

  return {
    ok: true,
    categories: normalizeRawSlugs(rawSlugs),
    ...(confidence !== undefined ? { confidence } : null),
    ...(reason !== undefined ? { reason } : null),
  }
}

function normalizeRawSlugs(raw: unknown[]): RepoCategorySlug[] {
  const candidates: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    const t = item.trim()
    if (!t) continue
    // 先当 slug，再当名称（中/英），都不是则原样交给 normalize 丢弃。
    const asSlug = t.toLowerCase()
    const slug = slugFromCategoryName(asSlug) ?? slugFromCategoryName(t)
    candidates.push(slug ?? asSlug)
  }
  return normalizeCategorySlugs(candidates)
}

function taxonomyBlock(): string {
  return REPO_CATEGORY_DEFINITIONS.map(
    (d) => `- ${d.slug}: ${d.nameEn} — ${d.descriptionEn}`
  ).join("\n")
}

function getModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini"
}

/**
 * 调用现有 openai 服务做一次分类。只返回固定 slug 数组。
 * 解析失败 / provider 失败都会 throw（由调用方视为 failed 落库）。
 */
export async function classifyWithLLM(
  ctx: LLMClassificationContext
): Promise<{ categories: RepoCategorySlug[]; confidence?: number; reason?: string; metrics: AnalysisMetrics }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new ClassificationLLMError(
      "OPENAI_API_KEY is not configured. Set it in .env to enable AI classification.",
      "MISSING_API_KEY"
    )
  }

  const metadata = [
    `Repository: ${ctx.fullName}`,
    `Description: ${ctx.description || "N/A"}`,
    `Language: ${ctx.language || "Unknown"}`,
    `Topics: ${ctx.topics.length > 0 ? ctx.topics.join(", ") : "None"}`,
    `Stars: ${ctx.stars}`,
    ctx.summaryText ? `Existing AI summary:\n${ctx.summaryText.slice(0, 4000)}` : null,
    ctx.readmeText ? `README excerpt:\n${ctx.readmeText.slice(0, 3000)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")

  const systemPrompt = [
    "You classify GitHub repositories by *function* (what it is for), not by programming language.",
    "Pick one or more categories from the taxonomy whose slug is most appropriate.",
    "Only use slugs from the list. Never invent new slugs or names.",
    "If truly no category fits, return [\"other\"].",
    "Return ONLY a JSON object and nothing else:",
    `{"categorySlugs": ["slug-a", "slug-b"], "confidence": 0.9, "reason": "short explanation"}`,
  ].join("\n")

  const userPrompt = [
    "Classify this GitHub repository:",
    metadata,
    "\nTaxonomy:",
    taxonomyBlock(),
  ].join("\n")

  const startedAt = Date.now()
  const response = await withRetry(
    () =>
      openai.chat.completions.create({
        model: getModel(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
    {
      maxRetries: LLM_MAX_RETRIES,
      isRetryable: isRetryableLLMError,
      onRetry: (err, attempt) => {
        console.warn(
          `[classification] Retrying LLM call (${attempt}/${LLM_MAX_RETRIES}):`,
          (err as Error).message
        )
      },
    }
  )

  const metrics: AnalysisMetrics = {
    durationMs: Date.now() - startedAt,
    tokensUsed: extractTokenUsage(response),
  }

  const content = response.choices?.[0]?.message?.content ?? ""
  const parsed = parseLLMClassification(content)
  if (!parsed.ok) {
    throw new ClassificationLLMError(
      `LLM classification output could not be parsed (${parsed.error})`,
      "PARSING_FAILED"
    )
  }

  return {
    categories: parsed.categories,
    ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : null),
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : null),
    metrics,
  }
}