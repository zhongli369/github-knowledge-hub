/**
 * GithubKnowledgeHub 自动分类引擎 — 公共入口。
 *
 * Agent D 与上游服务只需从这里导入：
 *   import { classifyRepository, classifyRepositories, ensureCategoryCollections, REPO_CATEGORY_DEFINITIONS } from "@/lib/classification"
 */

// taxonomy / 指纹 / 规则 / LLM 解析均为纯模块（可脱离 prisma 测试）。
export * from "./taxonomy"
export * from "./fingerprint"
export * from "./deterministic"
export { classifyWithLLM, parseLLMClassification, ClassificationLLMError } from "./llm"
export type { LLMClassificationResult, LLMClassificationContext } from "./llm"

// 编排层（依赖 prisma 新模型；集成测试由主 Agent/D 驱动，单测用 mock）。
export {
  classifyRepository,
  classifyRepositories,
  ensureCategoryCollections,
  syncAutoCollectionLinks,
} from "./service"
export type {
  ClassificationMode,
  ClassificationOutcome,
  ClassificationBatchResult,
  BatchProgress,
  ClassifyRepositoryArgs,
  ClassifyRepositoriesArgs,
} from "./service"