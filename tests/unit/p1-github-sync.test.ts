import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Octokit } from "@octokit/rest"

// ── External dependencies are fully mocked; no real network or DB access ──

const mocks = vi.hoisted(() => ({
  createOctokit: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock("@/lib/github/client", () => ({ createOctokit: mocks.createOctokit }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    repository: { upsert: mocks.upsert, findMany: mocks.findMany },
  },
}))

import {
  fetchUserRepos,
  fetchStarredRepos,
  fetchRepoReadme,
  fetchRepoDetails,
  syncRepoToDb,
  getUserReposFromDb,
  fetchRepoFileTree,
  fetchFileContent,
  type GitHubRepo,
} from "@/services/github/repos.service"

interface FakeTreeEntry {
  path?: string
  type?: string
  size?: number
}

function fakeOctokit(overrides: Record<string, unknown> = {}): Octokit {
  return {
    paginate: () => {
      throw new Error("paginate not stubbed")
    },
    repos: {},
    activity: {},
    git: {},
    ...overrides,
  } as unknown as Octokit
}

const rawRepo = {
  id: 123,
  owner: { login: "octocat" },
  name: "hello-world",
  full_name: "octocat/hello-world",
  description: "A demo repository",
  html_url: "https://github.com/octocat/hello-world",
  homepage: "https://octocat.dev",
  language: "TypeScript",
  stargazers_count: 50,
  forks_count: 4,
  topics: ["api", "demo"],
  default_branch: "main",
  archived: false,
  is_template: false,
  license: { spdx_id: "MIT" },
  size: 200,
  pushed_at: "2026-01-01T00:00:00Z",
}

const rawRepoMinimal = {
  id: 124,
  owner: { login: "octocat" },
  name: "bare",
  full_name: "octocat/bare",
  description: null,
  html_url: "https://github.com/octocat/bare",
  homepage: null,
  language: null,
  stargazers_count: 1,
  forks_count: 0,
  default_branch: "main",
  size: 3,
  pushed_at: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GitHub repo fetch and sync (Octokit mocked)", () => {
  it("maps authenticated user repos through paginate", async () => {
    const paginate = vi.fn().mockResolvedValue([rawRepo, rawRepoMinimal])
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({ paginate, repos: { listForAuthenticatedUser: vi.fn() } }),
    )

    const repos = await fetchUserRepos("user-1")

    expect(mocks.createOctokit).toHaveBeenCalledWith("user-1")
    expect(paginate).toHaveBeenCalledWith(expect.any(Function), {
      per_page: 100,
      sort: "updated",
      direction: "desc",
      type: "owner",
    })
    expect(repos).toHaveLength(2)

    expect(repos[0]).toMatchObject({
      id: 123,
      owner: "octocat",
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: "A demo repository",
      url: "https://github.com/octocat/hello-world",
      homepage: "https://octocat.dev",
      language: "TypeScript",
      stars: 50,
      forks: 4,
      topics: ["api", "demo"],
      defaultBranch: "main",
      isArchived: false,
      isTemplate: false,
      license: "MIT",
      size: 200,
      pushedAt: "2026-01-01T00:00:00Z",
    })

    // Minimally-populated payloads get safe defaults
    expect(repos[1]).toMatchObject({
      topics: [],
      isArchived: false,
      isTemplate: false,
      license: null,
      pushedAt: null,
    })
  })

  it("maps starred repos", async () => {
    const paginate = vi.fn().mockResolvedValue([rawRepo])
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({ paginate, activity: { listReposStarredByAuthenticatedUser: vi.fn() } }),
    )

    const repos = await fetchStarredRepos("user-1")

    expect(paginate).toHaveBeenCalledWith(expect.any(Function), { per_page: 100 })
    expect(repos[0].fullName).toBe("octocat/hello-world")
  })

  it("decodes a base64 README", async () => {
    const content = Buffer.from("# Hello\n\nA demo").toString("base64")
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        repos: { getReadme: vi.fn().mockResolvedValue({ data: { content } }) },
      }),
    )

    expect(await fetchRepoReadme("user-1", "octocat", "hello-world")).toBe("# Hello\n\nA demo")
  })

  it("returns null only for a genuine 404 README response", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        repos: {
          getReadme: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
        },
      }),
    )

    expect(await fetchRepoReadme("user-1", "octocat", "missing")).toBeNull()
  })

  it.each([403, 429, 500])("surfaces GitHub README status %i instead of treating it as missing", async (status) => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        repos: { getReadme: vi.fn().mockRejectedValue(Object.assign(new Error("upstream"), { status })) },
      }),
    )

    await expect(fetchRepoReadme("user-1", "octocat", "hello-world")).rejects.toMatchObject({ status })
  })

  it("surfaces README network failures instead of treating them as missing", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({ repos: { getReadme: vi.fn().mockRejectedValue(new Error("socket reset")) } }),
    )

    await expect(fetchRepoReadme("user-1", "octocat", "hello-world")).rejects.toThrow(/socket reset/)
  })

  it("maps single-repo details", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({ repos: { get: vi.fn().mockResolvedValue({ data: rawRepo }) } }),
    )

    const repo = await fetchRepoDetails("user-1", "octocat", "hello-world")
    expect(repo).toMatchObject({ id: 123, fullName: "octocat/hello-world", stars: 50 })
  })

  it("upserts a repo with full create and partial update payloads", async () => {
    mocks.upsert.mockResolvedValue({ id: "db-repo" })

    const repo: GitHubRepo = {
      id: 123,
      owner: "octocat",
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: "A demo repository",
      url: "https://github.com/octocat/hello-world",
      homepage: null,
      language: "TypeScript",
      stars: 50,
      forks: 4,
      topics: ["api"],
      defaultBranch: "main",
      isArchived: false,
      isTemplate: false,
      license: null,
      size: 200,
      pushedAt: "2026-01-01T00:00:00Z",
    }

    await syncRepoToDb("user-1", repo)

    expect(mocks.upsert).toHaveBeenCalledTimes(1)
    const { where, create, update } = mocks.upsert.mock.calls[0][0] as {
      where: { userId_githubId: { userId: string; githubId: number } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    // Per-user compound key: the upsert is scoped to (userId, githubId) so each
    // user gets their own Repository row for the same GitHub repository.
    expect(where).toEqual({ userId_githubId: { userId: "user-1", githubId: 123 } })
    expect(create).toMatchObject({
      githubId: 123,
      owner: "octocat",
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: "A demo repository",
      url: "https://github.com/octocat/hello-world",
      homepage: null,
      language: "TypeScript",
      stars: 50,
      forks: 4,
      topics: ["api"],
      defaultBranch: "main",
      isArchived: false,
      isTemplate: false,
      license: null,
      size: 200,
      userId: "user-1",
    })
    expect(create.pushedAt).toBeInstanceOf(Date)
    expect(create.lastFetchedAt).toBeInstanceOf(Date)

    expect(update).toMatchObject({
      description: "A demo repository",
      language: "TypeScript",
      stars: 50,
      forks: 4,
      topics: ["api"],
      defaultBranch: "main",
      isArchived: false,
      size: 200,
    })
    expect(update.pushedAt).toBeInstanceOf(Date)
    expect(update.lastFetchedAt).toBeInstanceOf(Date)
    // fullName/owner/url/homepage/isTemplate/userId must not move on updates
    expect(update).not.toHaveProperty("fullName")
    expect(update).not.toHaveProperty("owner")
    expect(update).not.toHaveProperty("url")
    expect(update).not.toHaveProperty("isTemplate")
    expect(update).not.toHaveProperty("userId")
  })

  it("stores a null pushedAt as null", async () => {
    mocks.upsert.mockResolvedValue({})
    const repo: GitHubRepo = {
      id: 124,
      owner: "octocat",
      name: "bare",
      fullName: "octocat/bare",
      description: null,
      url: "https://github.com/octocat/bare",
      homepage: null,
      language: null,
      stars: 1,
      forks: 0,
      topics: [],
      defaultBranch: "main",
      isArchived: false,
      isTemplate: false,
      license: null,
      size: 3,
      pushedAt: null,
    }
    await syncRepoToDb("user-1", repo)
    const { create, update } = mocks.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    expect(create.pushedAt).toBeNull()
    expect(update.pushedAt).toBeNull()
  })

  it("lets two users sync the same GitHub repository into independent rows", async () => {
    mocks.upsert.mockResolvedValue({ id: "db-repo" })

    const repo: GitHubRepo = {
      id: 123,
      owner: "octocat",
      name: "hello-world",
      fullName: "octocat/hello-world",
      description: "A demo repository",
      url: "https://github.com/octocat/hello-world",
      homepage: null,
      language: "TypeScript",
      stars: 50,
      forks: 4,
      topics: ["api"],
      defaultBranch: "main",
      isArchived: false,
      isTemplate: false,
      license: null,
      size: 200,
      pushedAt: null,
    }

    // User A syncs the repo, then user B syncs the same GitHub repository.
    await syncRepoToDb("user-a", repo)
    await syncRepoToDb("user-b", repo)

    expect(mocks.upsert).toHaveBeenCalledTimes(2)
    const first = mocks.upsert.mock.calls[0][0] as {
      where: { userId_githubId: { userId: string; githubId: number } }
      create: Record<string, unknown>
    }
    const second = mocks.upsert.mock.calls[1][0] as {
      where: { userId_githubId: { userId: string; githubId: number } }
      create: Record<string, unknown>
    }

    // Each upsert is keyed on its own (userId, githubId) and creates its own row.
    expect(first.where).toEqual({ userId_githubId: { userId: "user-a", githubId: 123 } })
    expect(first.create.userId).toBe("user-a")
    expect(first.create.fullName).toBe("octocat/hello-world")

    expect(second.where).toEqual({ userId_githubId: { userId: "user-b", githubId: 123 } })
    expect(second.create.userId).toBe("user-b")
    expect(second.create.fullName).toBe("octocat/hello-world")
  })

  it("loads user repos ordered by stars descending", async () => {
    mocks.findMany.mockResolvedValue([{ id: "repo-2" }, { id: "repo-1" }])
    const rows = await getUserReposFromDb("user-1")

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { stars: "desc" },
    })
    expect(rows).toEqual([{ id: "repo-2" }, { id: "repo-1" }])
  })
})

describe("fetchRepoFileTree filtering and failure handling", () => {
  const tree: FakeTreeEntry[] = [
    { path: "node_modules/foo/index.js", type: "blob", size: 10 },
    { path: "packages/demo/node_modules/nested.js", type: "blob", size: 10 },
    { path: "packages/demo/dist/generated.js", type: "blob", size: 10 },
    { path: "packages/demo/__pycache__/cache.py", type: "blob", size: 10 },
    { path: ".git/config", type: "blob", size: 50 },
    { path: "src/app.min.js", type: "blob", size: 100 },
    { path: "src/app.map.js", type: "blob", size: 100 },
    { path: "asset/hero.png", type: "blob", size: 5000 },
    { path: "src/huge.txt", type: "blob", size: 999_999 },
    { path: "src/main.ts", type: "blob", size: 2048 },
    { path: "README.md", type: "blob", size: 1024 },
    { path: "src/dir", type: "tree" },
    { path: "other/plain", type: "blob" },
    { path: ".env", type: "blob", size: 30 },
  ]

  it("drops binary, generated, oversized and ignored-directory entries", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        git: {
          getTree: vi.fn().mockResolvedValue({
            data: { tree },
          }),
        },
      }),
    )

    const entries = await fetchRepoFileTree("user-1", "octocat", "hello-world", "main")

    expect(mocks.createOctokit).toHaveBeenCalledWith("user-1")

    expect(entries).toEqual([
      { path: "src/main.ts", type: "file", size: 2048 },
      { path: "README.md", type: "file", size: 1024 },
      { path: "other/plain", type: "file", size: undefined },
      { path: ".env", type: "file", size: 30 },
    ])
  })

  it("caps the returned tree at MAX_TREE_ENTRIES", async () => {
    const bigTree: FakeTreeEntry[] = Array.from({ length: 250 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      type: "blob",
      size: 100,
    }))
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        git: { getTree: vi.fn().mockResolvedValue({ data: { tree: bigTree } }) },
      }),
    )

    const entries = await fetchRepoFileTree("user-1", "octocat", "hello-world")
    expect(entries).toHaveLength(200)
  })

  it("rejects a truncated recursive tree instead of extracting a partial repository", async () => {
    const getTree = vi.fn().mockResolvedValue({
      data: { truncated: true, tree: [{ path: "src/partial.ts", type: "blob", size: 10 }] },
    })
    mocks.createOctokit.mockResolvedValue(fakeOctokit({ git: { getTree } }))

    await expect(fetchRepoFileTree("user-1", "octocat", "hello-world", "main")).rejects.toThrow(/truncated tree/)
    expect(getTree).toHaveBeenCalledTimes(1)
  })

  it("surfaces rate limits and transport errors instead of returning an empty tree", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        git: { getTree: vi.fn().mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 })) },
      }),
    )

    await expect(fetchRepoFileTree("user-1", "octocat", "hello-world")).rejects.toMatchObject({ status: 429 })
  })

  it("returns an empty tree only for a genuine 404", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        git: { getTree: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })) },
      }),
    )

    await expect(fetchRepoFileTree("user-1", "octocat", "hello-world")).resolves.toEqual([])
  })
})

describe("fetchFileContent", () => {
  it("decodes file content from base64", async () => {
    const content = Buffer.from("export const x = 1").toString("base64")
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        repos: { getContent: vi.fn().mockResolvedValue({ data: { content } }) },
      }),
    )

    expect(await fetchFileContent("user-1", "octocat", "hello-world", "src/index.ts")).toBe(
      "export const x = 1",
    )
  })

  it("returns null when the path is a directory or content is missing", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        repos: {
          getContent: vi
            .fn()
            .mockResolvedValueOnce({ data: [{ name: "file.ts" }] })
            .mockResolvedValueOnce({ data: { name: "no-content" } }),
        },
      }),
    )

    expect(await fetchFileContent("user-1", "o", "r", "dir")).toBeNull()
    expect(await fetchFileContent("user-1", "o", "r", "nope")).toBeNull()
  })

  it("returns null when the file genuinely does not exist", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        repos: {
          getContent: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 })),
        },
      }),
    )

    expect(await fetchFileContent("user-1", "o", "r", "missing.ts")).toBeNull()
  })

  it("surfaces rate limits instead of skipping the file as missing", async () => {
    mocks.createOctokit.mockResolvedValue(
      fakeOctokit({
        repos: {
          getContent: vi.fn().mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 })),
        },
      }),
    )

    await expect(fetchFileContent("user-1", "o", "r", "limited.ts")).rejects.toMatchObject({ status: 429 })
  })
})