import { createOctokit } from "@/lib/github/client"

export interface CodeSearchResult {
  name: string
  path: string
  repository: string
  url: string
  sha: string
}

export async function searchCodeInRepo(
  userId: string,
  owner: string,
  repo: string,
  query: string
): Promise<CodeSearchResult[]> {
  const octokit = await createOctokit(userId)

  const q = `${query} repo:${owner}/${repo}`
  const { data } = await octokit.search.code({ q, per_page: 30 })

  return data.items.map((item) => ({
    name: item.name,
    path: item.path,
    repository: item.repository.full_name,
    url: item.html_url,
    sha: item.sha,
  }))
}

export async function searchReposByTopic(
  userId: string,
  topic: string
): Promise<string[]> {
  const octokit = await createOctokit(userId)

  const { data } = await octokit.search.repos({
    q: `topic:${topic}`,
    sort: "stars",
    order: "desc",
    per_page: 20,
  })

  return data.items.map((r) => r.full_name)
}

export async function getFileContent(
  userId: string,
  owner: string,
  repo: string,
  path: string
): Promise<string> {
  const octokit = await createOctokit(userId)

  const { data } = await octokit.repos.getContent({ owner, repo, path })

  if (!("content" in data)) {
    throw new Error(`${path} is a directory, not a file`)
  }

  return Buffer.from(data.content, "base64").toString("utf-8")
}
