/**
 * 确定性规则分类器。
 *
 * 优先级最高：纯规则、零成本、可预测、不依赖网络/LLM。规则按「功能/用途」
 * 匹配仓库文本（名/描述/topics/已有摘要/README）。允许一仓多分类。
 *
 * 设计约束：
 * - 规则不产生 `other`——`other` 只能由 LLM 明确给出。
 * - 规则必须克制：宁可漏（交给 LLM 兜底），不硬猜。完全无信号时返回空数组。
 */

import {
  normalizeCategorySlugs,
  type RepoCategorySlug,
} from "./taxonomy"

export interface DeterministicInput {
  name: string
  fullName: string
  description: string | null
  topics: string[]
  summaryText: string | null
  readmeText?: string | null
}

interface CategoryRule {
  slug: RepoCategorySlug
  /** 用于 topics 的精确词（小写）。 */
  topics: readonly string[]
  /** 文本正则（对 name/fullName/description/topics/摘要/README 的小写合集匹配）。 */
  pattern: RegExp
}

// 注意：正则只做粗信号。CJK 无词边界，采用子串；英文尽量词边界。
const RULES: readonly CategoryRule[] = [
  {
    slug: "ai-llm-agent",
    topics: [
      "ai", "llm", "large-language-model", "machine-learning", "deep-learning",
      "artificial-intelligence", "nlp", "generative-ai", "genai", "gpt", "chatgpt",
      "rag", "langchain", "llamaindex", "openai", "anthropic", "claude-ai",
      "huggingface", "pytorch", "tensorflow", "local-llm", "agents", "ai-agents",
      "multimodal", "diffusion", "embedding", "ollama", "vllm", "lora", "fine-tuning",
    ],
    pattern:
      /\b(?:ai|llm|gpt|rag|nlp|ml|genai|agent|agents|mcp)\b|\bmachine\s+learning\b|\bdeep\s+learning\b|\bneural\s+network\b|\b(?:langchain|llama(?:index)?|hugging[-\s]*face|openai|anthropic|claude|pytorch|tensorflow|ollama|vllm)\b|大模型|人工智能|机器学习|深度学习|智能体|提示词|自然语言|推理模型/i,
  },
  {
    slug: "frontend-ui",
    topics: [
      "react", "reactjs", "vue", "vuejs", "svelte", "solidjs", "angular", "angularjs",
      "nextjs", "nuxt", "astro", "tailwindcss", "tailwind", "css", "html", "webpack",
      "vite", "frontend", "ui", "ux", "design-system", "component-library", "shadcn-ui",
      "storybook", "chakra-ui", "mui", "material-ui", "pwa", "web-components",
    ],
    pattern:
      /\b(?:react|vue(?:\.?js)?|svelte|solid(?:js)?|angular|preact|remix|nuxt|astro|tailwind|webpack|vite|storybook|shadcn|bootstrap|chakra)\b|\bfront-?end\b|\bui\s+component|\bdesign\s+system\b|\bcss\b|前端|界面|组件库|样式框架|交互设计/i,
  },
  {
    slug: "backend-api",
    topics: [
      "api", "rest", "rest-api", "graphql", "grpc", "express", "fastapi", "flask",
      "django", "spring-boot", "nestjs", "koa", "serverless", "microservices",
      "webhook", "sdk", "backend", "api-client", "openapi", "endpoint",
    ],
    pattern:
      /\b(?:api|rest|graphql|grpc|express(?:\.js)?|fastapi|flask|django|spring\s*boot|nestjs|koa|serverless|microservice|webhook|sdk|oauth)\b|\bback-?end\b|\bapi\s*(?:client|server|endpoint|wrapper)\b|后端|接口|服务端|微服务|网关/i,
  },
  {
    slug: "data-database",
    topics: [
      "database", "sql", "postgresql", "postgres", "mysql", "sqlite", "redis",
      "mongodb", "clickhouse", "duckdb", "elasticsearch", "vector-database",
      "data", "data-engineering", "etl", "data-pipeline", "data-visualization",
      "pandas", "numpy", "airflow", "spark", "kafka", "lakehouse", "warehouse",
      "parquet", "grafana", "timeseries",
    ],
    pattern:
      /\b(?:database|postgres(?:ql)?|mysql|sqlite|redis|mongodb|clickhouse|duckdb|elasticsearch|airflow|spark|hadoop|elt|etl|kafka|warehouse)\b|\bvector\s*db\b|\bdata\s*(?:processing|pipelines?|analysis|engineering|visualization|storage)\b|\bpandas\b|\bnumpy\b|数据库|数据(?:处理|分析|工程|仓库|可视化|抓取|检索)|etl/i,
  },
  {
    slug: "automation-workflow",
    topics: [
      "automation", "workflow", "workflows", "orchestration", "pipeline", "pipelines",
      "scheduler", "scheduling", "n8n", "ci", "cd", "automation-tools", "bot", "bots",
      "ragflow", "cron", "tasks",
    ],
    pattern:
      /\b(?:automation|workflow|orchestr(?:at|ion)|pipeline|scheduler|cron|n8n|makefile|batch)\b|\bci\/?cd\b|自动化|工作流|定时任务|流程编排|机器人|解放双手/i,
  },
  {
    slug: "devtools-cli",
    topics: [
      "cli", "terminal", "command-line", "devtool", "devtools", "developer-tools",
      "dotfiles", "linter", "formatter", "snippets", "snippet", "code-snippets",
      "text-editor", "vim", "neovim", "shell", "zsh", "fish", "scaffold",
      "codegen", "boilerplate", "templates",
    ],
    pattern:
      /\b(?:cli|terminal|command-?line|dev-?tool|dotfiles|linter|formatter|snippet|scaffold|codegen|boilerplate)\b|\b(?:vim|neovim|zsh|fish)\b|\b[-\w]+\.config\b|开发工具|命令行|脚手架|配置管理|代码片段/i,
  },
  {
    slug: "crawler-scraping",
    topics: [
      "crawler", "web-crawler", "scraper", "web-scraping", "spider", "scheduler-crawler",
      "puppeteer", "playwright", "selenium", "cheerio", "beautifulsoup", "scrapy",
      "anti-scraping", "douban-crawler", "news-crawler",
    ],
    pattern:
      /\b(?:crawler|crawl|scraper|scraping|spider|puppeteer|playwright|selenium|cheerio|beautifulsoup|scrapy)\b|爬虫|抓取|采集|反爬/i,
  },
  {
    slug: "devops",
    topics: [
      "docker", "kubernetes", "k8s", "helm", "terraform", "ansible", "prometheus",
      "jenkins", "github-actions", "gitlab-ci", "devops", "infrastructure", "containers",
      "cloud-native", "observability", "opentelemetry", "monitoring", "nginx",
      "deployment", "IaC",
    ],
    pattern:
      /\b(?:docker|kubernetes|k8s|helm|terraform|ansible|prometheus|jenkins|nginx)\b|\bgithub\s*actions\b|\bgitlab\s*ci\b|\bci\/?cd\b|\binfra(?:structure)?\b|\bcontainer(?:s)?\b|\bobserv(?:ability)?\b|\bmicro?services\b|运维|部署|容器|云原生|持续集成|持续部署|可观测性/i,
  },
  {
    slug: "security-privacy",
    topics: [
      "security", "privacy", "encryption", "cryptography", "cipher", "decryption",
      "oauth", "jwt", "authentication", "authorization", "vault", "secret-management",
      "penetration-testing", "pentest", "malware", "fuzzing", "ids", "firewall",
      "zero-knowledge", "hashing", "password",
    ],
    pattern:
      /\b(?:security|privacy|encrypt|cryptograph|cipher|decrypt|hashing|oauth|jwt|auth[ntz])\b|\bpassword\s*manager\b|\bvault\b|\bpen?test\b|\bmalware\b|\bfuzz(?:ing)?\b|安全|隐私|加密|解密|渗透|漏洞|认证|授权|零知识/i,
  },
  {
    slug: "learning",
    topics: [
      "tutorial", "tutorials", "learning", "learn", "courses", "examples", "awesome",
      "awesome-list", "cheat-sheet", "handbook", "book", "ebook", "guide",
      "interview-questions", "roadmap", "playground", "demo", "docs",
    ],
    pattern:
      /\b(?:tutorial|tutorials|learn(?:ing)?|course|courses|examples?|\bguide\b|awesome|handbook|cheat[-\s]*sheet|playground|roadmap)\b|教程|学习|示例|指南|实战|入门|面试|刷题|知识库/i,
  },
  {
    slug: "other",
    topics: [],
    pattern: /$a^/, // never matches; other only from LLM
  },
]

/** 小写归一化后的匹配文本。 */
function buildText(input: DeterministicInput): string {
  const topics = Array.isArray(input.topics) ? input.topics : []
  return [
    input.fullName ?? "",
    input.name ?? "",
    input.description ?? "",
    topics.join(" "),
    input.summaryText ?? "",
    input.readmeText ?? "",
  ]
    .join("\n")
    .toLowerCase()
}

/**
 * 对输入执行确定性规则分类，返回合法、去重后的分类 slug 数组。
 * 可能返回空数组（规则未命中或有命中但被 normalize 丢弃）。
 */
export function classifyDeterministic(input: DeterministicInput): RepoCategorySlug[] {
  const text = buildText(input)
  const topicsLower = new Set(
    (Array.isArray(input.topics) ? input.topics : []).map((t) => t.trim().toLowerCase())
  )

  const matched: RepoCategorySlug[] = []
  for (const rule of RULES) {
    let hit = false
    for (const topic of rule.topics) {
      if (topicsLower.has(topic)) {
        hit = true
        break
      }
    }
    if (!hit && rule.pattern.test(text)) hit = true
    if (hit) matched.push(rule.slug)
  }

  // 规则不会产生 other；此处再做一次安全归一化（去重/丢弃非法）。
  return normalizeCategorySlugs(matched)
}