import { createOctokit } from "@/lib/github/client"
import { prisma } from "@/lib/prisma"
import { classifyGitHubError, isNotFound } from "./errors"

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
  // When returned by the starred endpoint with the custom `star+json` accept
  // header; undefined on other endpoints (repo list, get details).
  starredAt?: string | null
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
    starredAt: raw.starred_at ?? null,
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

/**
 * One item from the starred endpoint. With the `star+json` media type each item
 * is an envelope `{ starred_at, repo: {...} }` (the star time sits OUTSIDE the
 * nested repo object); without it the endpoint falls back to plain repo objects.
 */
interface StarredItem {
  starred_at?: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repo?: Record<string, any>
}

/**
 * Normalize one paginated starred item (envelope or plain-repo form) to a
 * `GitHubRepo`. The nested `repo` object carries the repository fields; the
 * outer `starred_at` (when present) is threaded through as the star time so the
 * sync can persist when the user actually starred the repo.
 */
function mapStarredItem(item: StarredItem): GitHubRepo {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: Record<string, any> = item.repo ?? (item as unknown as Record<string, any>)
  const mapped = mapRepo(raw)
  if (item.repo) {
    // The star time lives on the envelope, not inside the nested repo object.
    mapped.starredAt = item.starred_at ?? null
  }
  return mapped
}

export async function fetchStarredRepos(userId: string): Promise<GitHubRepo[]> {
  const octokit = await createOctokit(userId)

  // The `star+json` media type makes the starred endpoint include the
  // `starred_at` field on every item; without it the response omits star time.
  const repos = await octokit.paginate(
    octokit.activity.listReposStarredByAuthenticatedUser,
    {
      per_page: 100,
      headers: { accept: "application/vnd.github.star+json" },
    }
  )

  return repos.map(mapStarredItem)
}

/**
 * Resolve the current HEAD commit SHA of a repository's default branch.
 *
 * Returns `null` for a 404 (missing repository/branch) and for repositories
 * that have no commits yet (an empty repo exposes no branch commit). All other
 * failures are classified so transient / rate-limit / auth issues surface as
 * exceptions instead of being silently treated as "no head".
 */
export async function fetchRepositoryHeadSha(
  userId: string,
  owner: string,
  repo: string,
  defaultBranch: string
): Promise<string | null> {
  const octokit = await createOctokit(userId)

  try {
    const { data } = await octokit.repos.getBranch({ owner, repo, branch: defaultBranch })
    return data.commit?.sha ?? null
  } catch (error) {
    if (isNotFound(error)) return null
    return classifyGitHubError(error)
  }
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
  } catch (error) {
    if (isNotFound(error)) return null
    return classifyGitHubError(error)
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
  // Per-user upsert key: two users syncing the same GitHub repository must get
  // their own Repository rows. The global-unique githubId/fullName constraints
  // are replaced by compound (userId, githubId) / (userId, fullName) uniques so
  // user B syncing a repo already tracked by user A creates B's own row instead
  // of stealing/overwriting A's.
  await prisma.repository.upsert({
    where: { userId_githubId: { userId, githubId: repo.id } },
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
      starredAt: repo.starredAt ? new Date(repo.starredAt) : null,
      unstarredAt: null,
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
const SKIP_FILE_PATTERNS = [/\.min\.js$/, /\.bundle\.js$/, /\.chunk\.js$/, /\.map\.js$/]
const MAX_FILE_SIZE = 500_000 // 500KB
const MAX_TREE_ENTRIES = 200

export class GitHubTreeTruncatedError extends Error {
  override readonly name = "GitHubTreeTruncatedError"

  constructor(owner: string, repo: string) {
    super(`GitHub returned a truncated tree for ${owner}/${repo}; refusing partial extraction`)
  }
}

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

    if (data.truncated) {
      throw new GitHubTreeTruncatedError(owner, repo)
    }

    const entries: RepoFileEntry[] = []
    for (const item of data.tree) {
      if (!item.path || !item.type) continue
      if (entries.length >= MAX_TREE_ENTRIES) break

      // Exclude files below ignored directories as well as the tree entries.
      // GitHub's recursive response does not guarantee a parent tree row.
      if (SKIP_DIRS.some((dir) => item.path!.startsWith(dir) || item.path!.includes(`/${dir}`))) continue

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
    if (error instanceof GitHubTreeTruncatedError) throw error
    if (isNotFound(error)) return []
    return classifyGitHubError(error)
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
  } catch (error) {
    if (isNotFound(error)) return null
    return classifyGitHubError(error)
  }
}
