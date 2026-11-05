/**
 * 确定性内容指纹 (SHA-256)。
 *
 * 分类基于仓库元数据 + 已有的 repo_summary（+ 可选 README）。任何影响分类的
 * 输入变化都必须反映在指纹里，这样「hash 未变 + 已 classified + 版本相同」时
 * 可以直接 skipped，不重跑规则、不调用 AI。
 */

import { createHash } from "node:crypto"

/** 分类器版本。规则/taxonomy 变更时递增，以触发已 classified 仓库重分类。 */
export const CLASSIFIER_VERSION = "1.0.0"

/** 参与指纹的仓库元数据 + 已有摘要文本。 */
export interface FingerprintSource {
  name: string
  fullName: string
  description: string | null
  language: string | null
  homepage: string | null
  topics: string[]
  summaryText: string | null
}

/** 规范化后计算 SHA-256。对象 key 顺序固定、topics 排序，保证确定性。 */
export function computeRepoContentHash(src: FingerprintSource): string {
  const canonical = {
    name: src.name ?? "",
    fullName: src.fullName ?? "",
    description: src.description ?? "",
    language: src.language ?? "",
    homepage: src.homepage ?? "",
    topics: Array.isArray(src.topics) ? [...src.topics].sort() : [],
    summaryText: src.summaryText ?? "",
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/**
 * 从 Analysis.result 中提取 repo_summary 的纯文本表示，供规则分类与 LLM 使用。
 * `result` 形如 `{ summary: { oneLine, problem, techStack, scenarios, highlights,
 * learningValue, reuseSuggestion, simpleExplanation }, rawContent }`。
 * 结构不完整/类型不对时返回 null，绝不抛错。
 */
export function extractSummaryText(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null
  const record = result as Record<string, unknown>
  const summary = record.summary
  if (typeof summary !== "object" || summary === null) return null

  const s = summary as Record<string, unknown>
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) parts.push(value.trim())
  }
  const pushArray = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) push(item)
  }

  push(s.oneLine)
  push(s.problem)
  pushArray(s.techStack)
  pushArray(s.scenarios)
  pushArray(s.highlights)
  push(s.learningValue)
  push(s.reuseSuggestion)
  push(s.simpleExplanation)

  return parts.length > 0 ? parts.join("\n") : null
}

/**
 * 判断是否具备「足以让规则或 LLM 做决定」的信息。
 * 完全没有任何内容信号（无描述、无 topics、无摘要、无 README）时返回 false，
 * 此时既不调用 LLM 也不硬猜，标记 unclassified。
 */
export function hasSufficientCategorySignal(input: {
  description: string | null
  topics: string[]
  summaryText: string | null
  readmeText: string | null
}): boolean {
  const topics = Array.isArray(input.topics) ? input.topics : []
  return Boolean(
    input.description?.trim() ||
      topics.length > 0 ||
      input.summaryText?.trim() ||
      input.readmeText?.trim()
  )
}