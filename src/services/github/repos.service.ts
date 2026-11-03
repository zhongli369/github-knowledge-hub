import { createOctokit } from "@/lib/github/client"
import { prisma } from "@/lib/prisma"

export interface GitHubRepo {
  id: number
  owner: string
  name: string
  fullName: string
  description: string | null
  url: string
  homepage: string | null
  language: string | null
  stars: number
  forks: number
  topics: string[]
  defaultBranch: string
  isArchived: boolean
  isTemplate: boolean
  license: string | null
  size: number
  pushedAt: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRepo(raw: Record<string, any>): GitHubRepo {
  return {
    id: raw.id,
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    description: raw.description,
    url: raw.html_url,
    homepage: raw.homepage,
    language: raw.language,
    stars: raw.stargazers_count,
    forks: raw.forks_count,
    topics: raw.topics ?? [],
    defaultBranch: raw.default_branch,
    isArchived: raw.archived ?? false,
    isTemplate: raw.is_template ?? false,
    license: raw.license?.spdx_id ?? null,
    size: raw.size,
    pushedAt: raw.pushed_at,
  }
}

export async function fetchUserRepos(userId: string): Promise<GitHubRepo[]> {
  const octokit = await createOctokit(userId)

  const repos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
    per_page: 100,
    sort: "updated",
    direction: "desc",
    type: "owner",
  })

  return repos.map(mapRepo)
}

export async function fetchStarredRepos(userId: string): Promise<GitHubRepo[]> {
  const octokit = await createOctokit(userId)

  const repos = await octokit.paginate(
    octokit.activity.listReposStarredByAuthenticatedUser,
    { per_page: 100 }
  )

  return repos.map((r) => mapRepo(r as Parameters<typeof mapRepo>[0]))
}

export async function fetchRepoReadme(
  userId: string,
  owner: string,
  repo: string
): Promise<string | null> {
  const octokit = await createOctokit(userId)

  try {
    const { data } = await octokit.repos.getReadme({ owner, repo })
    const content = Buffer.from(data.content, "base64").toString("utf-8")
    return content
  } catch {
    return null
  }
}

export async function fetchRepoDetails(
  userId: string,
  owner: string,
  repo: string
): Promise<GitHubRepo> {
  const octokit = await createOctokit(userId)
  const { data } = await octokit.repos.get({ owner, repo })
  return mapRepo(data as Parameters<typeof mapRepo>[0])
}

export async function syncRepoToDb(
  userId: string,
  repo: GitHubRepo
): Promise<void> {
  await prisma.repository.upsert({
    where: { githubId: repo.id },
    create: {
      githubId: repo.id,
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      description: repo.description,
      url: repo.url,
      homepage: repo.homepage,
      language: repo.language,
      stars: repo.stars,
      forks: repo.forks,
      topics: repo.topics,
      defaultBranch: repo.defaultBranch,
      isArchived: repo.isArchived,
      isTemplate: repo.isTemplate,
      license: repo.license,
      size: repo.size,
      pushedAt: repo.pushedAt ? new Date(repo.pushedAt) : null,
      lastFetchedAt: new Date(),
      userId,
    },
    update: {
      description: repo.description,
      language: repo.language,
      stars: repo.stars,
      forks: repo.forks,
      topics: repo.topics,
      defaultBranch: repo.defaultBranch,
      isArchived: repo.isArchived,
      size: repo.size,
      pushedAt: repo.pushedAt ? new Date(repo.pushedAt) : null,
      lastFetchedAt: new Date(),
    },
  })
}

export async function getUserReposFromDb(userId: string) {
  return prisma.repository.findMany({
    where: { userId },
    orderBy: { stars: "desc" },
  })
}

// ── File tree fetching ───────────────────────────────────────────

export interface RepoFileEntry {
  path: string
  type: "file" | "dir"
  size?: number
}

const SKIP_DIRS = [
  "node_modules/", ".git/", "dist/", "build/", ".next/",
  "__pycache__/", "vendor/", ".venv/", "venv/", "target/",
]
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".tar",
  ".gz", ".webp", ".svg", ".woff", ".woff2", ".ttf", ".eot", ".mp4",
  ".mp3", ".mov", ".avi", ".lock", ".sum", ".map",
])
const SKIP_FILE_PATTERNS = [/\.min\.js$/, /\.bundle\.js$/, /\.chunk\.js$/]
const MAX_FILE_SIZE = 500_000 // 500KB
const MAX_TREE_ENTRIES = 200

export async function fetchRepoFileTree(
  userId: string,
  owner: string,
  repo: string,
  branch?: string
): Promise<RepoFileEntry[]> {
  const octokit = await createOctokit(userId)

  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: branch || "HEAD",
      recursive: "1" as unknown as undefined,
    })

    const entries: RepoFileEntry[] = []
    for (const item of data.tree) {
      if (!item.path || !item.type) continue
      if (entries.length >= MAX_TREE_ENTRIES) break

      // Filter dirs
      if (item.type === "tree" && SKIP_DIRS.some((d) => item.path!.startsWith(d))) continue

      // Filter files
      if (item.type === "blob") {
        const ext = item.path!.slice(item.path!.lastIndexOf(".")).toLowerCase()
        if (SKIP_EXTENSIONS.has(ext)) continue
        if (SKIP_FILE_PATTERNS.some((p) => p.test(item.path!))) continue
        if (item.size && item.size > MAX_FILE_SIZE) continue

        entries.push({ path: item.path!, type: "file", size: item.size })
      }
    }

    return entries
  } catch (error) {
    const msg = error instanceof Error ? error.message : ""
    if (msg.includes("tree too large") || msg.includes("too large")) {
      // Fallback: non-recursive (top-level only)
      const { data } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch || "HEAD",
      })
      const entries: RepoFileEntry[] = []
      for (const item of data.tree) {
        if (!item.path || !item.type) continue
        if (entries.length >= MAX_TREE_ENTRIES) break
        if (item.type === "blob") {
          entries.push({ path: item.path!, type: "file", size: item.size })
        }
      }
      return entries
    }
    console.warn(`[github] Failed to fetch file tree for ${owner}/${repo}:`, msg)
    return []
  }
}

export async function fetchFileContent(
  userId: string,
  owner: string,
  repo: string,
  path: string
): Promise<string | null> {
  const octokit = await createOctokit(userId)
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path })
    if (Array.isArray(data) || !("content" in data) || !data.content) return null
    return Buffer.from(data.content, "base64").toString("utf-8")
  } catch {
    return null
  }
}
