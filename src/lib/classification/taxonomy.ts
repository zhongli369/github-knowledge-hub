/**
 * 仓库分类法 (taxonomy)。
 *
 * 固定、可扩展、按功能而非语言。slug 一经发布不得变更（数据库、集合、
 * 分类结果都会持久化 slug）。collections 的 `kind="category"` + `slug` 与这里
 * 一一对应。
 *
 * 规则：
 * - 只按「功能/用途」分类，绝不用 TypeScript/Python/Rust 等编程语言作功能分类。
 * - `other` 只允许由 LLM 明确给出；确定性规则永远不会产生 `other`。
 * - 「other 不与具体分类无意义并列」在 `normalizeCategorySlugs` 中处理：一旦
 *   同时返回了具体分类，`other` 会被丢弃。
 */

export const REPO_CATEGORY_SLUGS = [
  "ai-llm-agent",
  "frontend-ui",
  "backend-api",
  "data-database",
  "automation-workflow",
  "devtools-cli",
  "crawler-scraping",
  "devops",
  "security-privacy",
  "learning",
  "other",
] as const

export type RepoCategorySlug = (typeof REPO_CATEGORY_SLUGS)[number]

export interface RepoCategoryDefinition {
  /** 稳定 slug（库内唯一标识）。 */
  slug: RepoCategorySlug
  /** 中文名（用于自动创建的 category collection 名称）。 */
  nameZh: string
  /** 英文名。 */
  nameEn: string
  /** 中文描述。 */
  descriptionZh: string
  /** 英文描述（用于给 LLM 的分类说明）。 */
  descriptionEn: string
}

/** 固定分类定义。新增分类必须同时更新这里与 `REPO_CATEGORY_SLUGS`。 */
export const REPO_CATEGORY_DEFINITIONS: readonly RepoCategoryDefinition[] = [
  {
    slug: "ai-llm-agent",
    nameZh: "AI / 大模型 / Agent",
    nameEn: "AI / LLM / Agent",
    descriptionZh: "大语言模型、机器学习、智能体、推理与相关工具",
    descriptionEn: "LLMs, machine learning, agents, inference and related tooling",
  },
  {
    slug: "frontend-ui",
    nameZh: "前端 / UI",
    nameEn: "Frontend / UI",
    descriptionZh: "Web 前端、界面组件、样式与交互",
    descriptionEn: "Web frontend, UI components, styling and interaction",
  },
  {
    slug: "backend-api",
    nameZh: "后端 / API",
    nameEn: "Backend / API",
    descriptionZh: "服务端逻辑、接口、协议与集成",
    descriptionEn: "Server-side logic, APIs, protocols and integrations",
  },
  {
    slug: "data-database",
    nameZh: "数据 / 数据库",
    nameEn: "Data / Database",
    descriptionZh: "数据存储、处理、ETL、检索与可视化",
    descriptionEn: "Storage, data processing, ETL, search and visualization",
  },
  {
    slug: "automation-workflow",
    nameZh: "自动化 / 工作流",
    nameEn: "Automation / Workflow",
    descriptionZh: "任务自动化、流水线与工作流编排",
    descriptionEn: "Task automation, pipelines and workflow orchestration",
  },
  {
    slug: "devtools-cli",
    nameZh: "开发工具 / CLI",
    nameEn: "DevTools / CLI",
    descriptionZh: "命令行工具、开发者工具、脚手架与库",
    descriptionEn: "CLI tools, developer tooling, scaffolding and libraries",
  },
  {
    slug: "crawler-scraping",
    nameZh: "爬虫 / 采集",
    nameEn: "Crawler / Scraping",
    descriptionZh: "网页抓取、数据采集与解析",
    descriptionEn: "Web crawling, data collection and parsing",
  },
  {
    slug: "devops",
    nameZh: "DevOps / 运维",
    nameEn: "DevOps",
    descriptionZh: "部署、容器、CI/CD 与云基础设施",
    descriptionEn: "Deployment, containers, CI/CD and cloud infrastructure",
  },
  {
    slug: "security-privacy",
    nameZh: "安全 / 隐私",
    nameEn: "Security / Privacy",
    descriptionZh: "安全审计、加密、隐私与合规",
    descriptionEn: "Security auditing, encryption, privacy and compliance",
  },
  {
    slug: "learning",
    nameZh: "教程 / 学习",
    nameEn: "Learning",
    descriptionZh: "教程、示例、文档与学习资源",
    descriptionEn: "Tutorials, examples, documentation and learning resources",
  },
  {
    slug: "other",
    nameZh: "其他",
    nameEn: "Other",
    descriptionZh: "无法归入以上分类的仓库",
    descriptionEn: "Repositories that do not fit the other categories",
  },
]

/** slug → 定义。 */
export const REPO_CATEGORY_BY_SLUG: Readonly<Record<string, RepoCategoryDefinition>> =
  Object.fromEntries(REPO_CATEGORY_DEFINITIONS.map((d) => [d.slug, d]))

/** 所有合法 slug 的集合。 */
export const REPO_CATEGORY_SLUG_SET: ReadonlySet<string> = new Set(REPO_CATEGORY_SLUGS)

export function isValidCategorySlug(slug: unknown): slug is RepoCategorySlug {
  return typeof slug === "string" && REPO_CATEGORY_SLUG_SET.has(slug)
}

/** 中英文名 → slug 别名（用于把 LLM 返回的名称规范化为 slug）。 */
const NAME_TO_SLUG: Record<string, RepoCategorySlug> = {}
for (const def of REPO_CATEGORY_DEFINITIONS) {
  NAME_TO_SLUG[def.nameZh.toLowerCase()] = def.slug
  NAME_TO_SLUG[def.nameEn.toLowerCase()] = def.slug
  NAME_TO_SLUG[def.slug] = def.slug
}

/** 把 LLM 可能返回的类别名称（中/英文名或 slug）解析为 slug。 */
export function slugFromCategoryName(name: unknown): RepoCategorySlug | null {
  if (typeof name !== "string") return null
  const t = name.trim().toLowerCase()
  if (!t) return null
  return NAME_TO_SLUG[t] ?? null
}

/**
 * 把任意来源的原始 slug 数组规范化为唯一、合法的分类 slug 数组。
 *
 * - 丢弃未知/非法 slug（LLM 返回的未知 slug 一律拒绝）。
 * - 去重。
 * - 「other 不与具体分类无意义并列」：一旦存在具体分类，`other` 被丢弃。
 */
export function normalizeCategorySlugs(raw: Iterable<unknown>): RepoCategorySlug[] {
  const out: RepoCategorySlug[] = []
  const seen = new Set<RepoCategorySlug>()
  for (const item of raw) {
    if (typeof item !== "string") continue
    const t = item.trim().toLowerCase()
    if (!t) continue
    if (!isValidCategorySlug(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  if (out.includes("other") && out.some((s) => s !== "other")) {
    return out.filter((s) => s !== "other")
  }
  return out
}

/** 校验 taxonomy 自身的结构（新增分类时用于测试/启动自检）。 */
export function validateTaxonomy(): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const def of REPO_CATEGORY_DEFINITIONS) {
    if (!isValidCategorySlug(def.slug)) errors.push(`未知 slug: ${def.slug}`)
    if (seen.has(def.slug)) errors.push(`重复 slug: ${def.slug}`)
    seen.add(def.slug)
    for (const key of ["nameZh", "nameEn", "descriptionZh", "descriptionEn"] as const) {
      if (!def[key]?.trim()) errors.push(`${def.slug} 缺少 ${key}`)
    }
  }
  for (const slug of REPO_CATEGORY_SLUGS) {
    if (!seen.has(slug)) errors.push(`REPO_CATEGORY_SLUGS 中存在但无定义: ${slug}`)
  }
  for (const slug of seen) {
    if (!REPO_CATEGORY_SLUGS.includes(slug as RepoCategorySlug)) {
      errors.push(`有定义但不在 REPO_CATEGORY_SLUGS 中: ${slug}`)
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}