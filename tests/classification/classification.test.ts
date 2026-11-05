import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"

// ── 纯函数测试：taxonomy / fingerprint / deterministic / LLM 解析 ──
// 不涉及 prisma 与网络。

// openai 全量 mock（hoisted），classifyWithLLM 不会触发真实网络。
const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
}))
vi.mock("@/lib/openai", () => ({
  openai: { chat: { completions: { create: mocks.openaiCreate } } },
}))

import {
  REPO_CATEGORY_DEFINITIONS,
  REPO_CATEGORY_SLUGS,
  validateTaxonomy,
  normalizeCategorySlugs,
  isValidCategorySlug,
  slugFromCategoryName,
} from "@/lib/classification/taxonomy"
import { CLASSIFIER_VERSION, computeRepoContentHash, extractSummaryText, hasSufficientCategorySignal } from "@/lib/classification/fingerprint"
import { classifyDeterministic } from "@/lib/classification/deterministic"
import { parseLLMClassification, classifyWithLLM, ClassificationLLMError } from "@/lib/classification/llm"

describe("taxonomy", () => {
  it("is structurally valid and complete", () => {
    const result = validateTaxonomy()
    expect(result.ok).toBe(true)
    if (!result.ok) expect(result.errors).toEqual([])
  })

  it("covers required categories with stable slugs and zh/en fields", () => {
    const required = [
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
    ]
    for (const slug of required) {
      const def = REPO_CATEGORY_DEFINITIONS.find((d) => d.slug === slug)
      expect(def, `missing category ${slug}`).toBeDefined()
      expect(def!.nameZh?.trim()).toBeTruthy()
      expect(def!.nameEn?.trim()).toBeTruthy()
      expect(def!.descriptionZh?.trim()).toBeTruthy()
      expect(def!.descriptionEn?.trim()).toBeTruthy()
    }
  })

  it("never uses a programming language as a functional category", () => {
    for (const slug of REPO_CATEGORY_SLUGS) {
      expect(slug).not.toMatch(/^(typescript|javascript|python|rust|go|java|golang|c\+\+|ruby)$/i)
    }
    const names = REPO_CATEGORY_DEFINITIONS.map((d) => d.nameEn.toLowerCase()).join(" ")
    expect(names).not.toMatch(/typescript|python|javascript/)
  })

  it("slugs are unique and all defined slugs are valid", () => {
    const slugs = REPO_CATEGORY_DEFINITIONS.map((d) => d.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of slugs) expect(isValidCategorySlug(s)).toBe(true)
    expect(REPO_CATEGORY_SLUGS.length).toBeGreaterThanOrEqual(11)
  })
})

describe("normalizeCategorySlugs", () => {
  it("dedupes and drops unknown slugs", () => {
    expect(normalizeCategorySlugs(["ai-llm-agent", "ai-llm-agent", "bogus", "LEARNING"])).toEqual([
      "ai-llm-agent",
      "learning",
    ])
  })

  it("keeps other alone", () => {
    expect(normalizeCategorySlugs(["other"])).toEqual(["other"])
  })

  it("drops other when concrete categories are present", () => {
    expect(normalizeCategorySlugs(["other", "learning", "devops"])).toEqual(["learning", "devops"])
    expect(normalizeCategorySlugs(["learning", "other"])).toEqual(["learning"])
  })

  it("returns empty for empty/illegal input", () => {
    expect(normalizeCategorySlugs([])).toEqual([])
    expect(normalizeCategorySlugs([42, null, ""])).toEqual([])
  })
})

describe("slugFromCategoryName", () => {
  it("maps zh/en names and slugs", () => {
    expect(slugFromCategoryName("教程 / 学习")).toBe("learning")
    expect(slugFromCategoryName("Learning")).toBe("learning")
    expect(slugFromCategoryName("data-database")).toBe("data-database")
    expect(slugFromCategoryName("nonsense")).toBeNull()
  })
})

describe("fingerprint", () => {
  const base = {
    name: "repo-a",
    fullName: "u/repo-a",
    description: "desc",
    language: "TypeScript",
    homepage: null,
    topics: ["b", "a"],
    summaryText: null,
  }

  it("is stable and sorts topics", () => {
    const h1 = computeRepoContentHash(base)
    const h2 = computeRepoContentHash({ ...base, topics: ["a", "b"] })
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("changes when functional signal changes", () => {
    const h1 = computeRepoContentHash(base)
    const h2 = computeRepoContentHash({ ...base, description: "different" })
    const h3 = computeRepoContentHash({ ...base, summaryText: "AI toolkit" })
    expect(h2).not.toBe(h1)
    expect(h3).not.toBe(h1)
  })

  it("extracts repo_summary text from Analysis.result", () => {
    const result = {
      summary: {
        oneLine: "A scraper",
        problem: "Gathers news",
        techStack: ["TypeScript"],
        scenarios: ["Data"],
        highlights: ["Fast"],
        learningValue: "Crawler patterns",
        reuseSuggestion: "Reuse",
        simpleExplanation: "A news crawler.",
      },
      rawContent: "ignored",
    }
    const text = extractSummaryText(result)
    expect(text).toContain("A scraper")
    expect(text).toContain("Gathers news")
    expect(text).toContain("TypeScript")
    expect(text).toContain("Crawler patterns")
  })

  it("returns null for malformed summaries", () => {
    expect(extractSummaryText(null)).toBeNull()
    expect(extractSummaryText({ rawContent: "x" })).toBeNull()
    expect(extractSummaryText({ summary: null })).toBeNull()
  })

  it("classifier version is stable and semver-like", () => {
    expect(CLASSIFIER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("hasSufficientCategorySignal requires real content", () => {
    expect(hasSufficientCategorySignal({ description: null, topics: [], summaryText: null, readmeText: null })).toBe(false)
    expect(hasSufficientCategorySignal({ description: "desc", topics: [], summaryText: null, readmeText: null })).toBe(true)
    expect(hasSufficientCategorySignal({ description: null, topics: ["ai"], summaryText: null, readmeText: null })).toBe(true)
  })
})

describe("deterministic classifier", () => {
  const base = { name: "x", fullName: "u/x", description: null, topics: [], summaryText: null, readmeText: null }

  it("classifies AI/LLM repos by topic, not language", () => {
    const cats = classifyDeterministic({
      ...base,
      name: "awesome-llm",
      fullName: "u/awesome-llm",
      description: "Curated list of large language model resources",
      topics: ["machine-learning"],
    })
    expect(cats).toContain("ai-llm-agent")
  })

  it("classifies a web scraper", () => {
    const cats = classifyDeterministic({
      ...base,
      description: "A web scraper that collects news from multiple sites",
      topics: ["crawler"],
    })
    expect(cats).toContain("crawler-scraping")
  })

  it("supports multi-classification", () => {
    const cats = classifyDeterministic({
      ...base,
      description: "Automated crawler pipeline for scraping ai news with a dashboard",
      topics: ["automation", "crawler"],
    })
    expect(cats).toContain("automation-workflow")
    expect(cats).toContain("crawler-scraping")
  })

  it("does NOT classify by programming language", () => {
    const cats = classifyDeterministic({
      ...base,
      description: "TypeScript utilities library",
      topics: [],
    })
    expect(cats).toEqual([])
    const cats2 = classifyDeterministic({
      ...base,
      description: "Rust performance toolkit",
      topics: [],
    })
    expect(cats2).toEqual([])
  })

  it("returns empty when no functional signal matches", () => {
    expect(classifyDeterministic(base)).toEqual([])
  })

  it("never outputs other from rules", () => {
    const cats = classifyDeterministic(base)
    expect(cats).not.toContain("other")
  })
})

describe("parseLLMClassification", () => {
  it("parses a JSON object with valid slugs", () => {
    const parsed = parseLLMClassification(
      '{"categorySlugs":["ai-llm-agent","learning"],"confidence":0.95,"reason":"NLP toolkit"}'
    )
    expect(parsed).toMatchObject({ ok: true, categories: ["ai-llm-agent", "learning"], confidence: 0.95, reason: "NLP toolkit" })
  })

  it("strips markdown code fences", () => {
    const parsed = parseLLMClassification(
      '```json\n{"categorySlugs": ["devtools-cli"]}\n```'
    )
    expect(parsed).toMatchObject({ ok: true, categories: ["devtools-cli"] })
  })

  it("parses a bare array", () => {
    const parsed = parseLLMClassification('["frontend-ui","devops"]')
    expect(parsed).toMatchObject({ ok: true, categories: ["frontend-ui", "devops"] })
  })

  it("accepts category_slugs snake_case key", () => {
    const parsed = parseLLMClassification('{"category_slugs":["security-privacy"]}')
    expect(parsed).toMatchObject({ ok: true, categories: ["security-privacy"] })
  })

  it("rejects unknown slugs and maps Chinese names", () => {
    const parsed = parseLLMClassification(
      '{"categorySlugs":["ai-llm-agent","not-a-real-slug","教程 / 学习","LEARNING"]}'
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.categories).toEqual(["ai-llm-agent", "learning"])
    }
  })

  it("drops other when concrete categories present; keeps it alone", () => {
    const withOther = parseLLMClassification('{"categorySlugs":["other","data-database"]}')
    expect(withOther.ok && withOther.categories).toEqual(["data-database"])
    const alone = parseLLMClassification('["other"]')
    expect(alone.ok && alone.categories).toEqual(["other"])
  })

  it("fails on invalid JSON", () => {
    expect(parseLLMClassification("certainly not json")).toEqual({ ok: false, error: "invalid-json" })
  })

  it("rejects out-of-range confidence via zod", () => {
    const parsed = parseLLMClassification('{"categorySlugs":["devops"],"confidence":2}')
    expect(parsed).toMatchObject({ ok: false })
  })

  it("rejects non-object non-array output", () => {
    expect(parseLLMClassification("42")).toMatchObject({ ok: false })
  })
})

describe("classifyWithLLM", () => {
  const savedKey = process.env.OPENAI_API_KEY
  const savedDelay = process.env.LLM_RETRY_BASE_DELAY_MS

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = "sk-test-not-real"
    process.env.LLM_RETRY_BASE_DELAY_MS = "0"
  })

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
    if (savedDelay === undefined) delete process.env.LLM_RETRY_BASE_DELAY_MS
    else process.env.LLM_RETRY_BASE_DELAY_MS = savedDelay
  })

  it("returns validated categories with confidence and telemetry", async () => {
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '{"categorySlugs":["ai-llm-agent","learning"],"confidence":0.9,"reason":"RAG stack"}' } }],
      usage: { total_tokens: 120 },
    })
    const res = await classifyWithLLM({
      fullName: "u/rag",
      description: "A RAG knowledge base",
      language: "TypeScript",
      topics: ["rag"],
      stars: 100,
      summaryText: null,
      readmeText: null,
    })
    expect(res.categories).toEqual(["ai-llm-agent", "learning"])
    expect(res.confidence).toBe(0.9)
    expect(res.reason).toBe("RAG stack")
    expect(res.metrics.tokensUsed).toBe(120)
  })

  it("throws MISSING_API_KEY without calling the provider when key is unset", async () => {
    delete process.env.OPENAI_API_KEY
    await expect(
      classifyWithLLM({ fullName: "u/x", description: "x", language: null, topics: [], stars: 0, summaryText: null, readmeText: null })
    ).rejects.toMatchObject({ code: "MISSING_API_KEY" })
    expect(mocks.openaiCreate).not.toHaveBeenCalled()
  })

  it("throws PARSING_FAILED when the provider returns garbage", async () => {
    mocks.openaiCreate.mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    })
    await expect(
      classifyWithLLM({ fullName: "u/x", description: "x", language: null, topics: [], stars: 0, summaryText: null, readmeText: null })
    ).rejects.toBeInstanceOf(ClassificationLLMError)
  })
})