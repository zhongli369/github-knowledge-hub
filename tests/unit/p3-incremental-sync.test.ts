import { describe, expect, it, vi } from "vitest"
import type { GitHubRepo } from "@/services/github"

// ── P3 incremental-sync pure functions (no DB / network) ──
// Contract: createRepositorySyncHash(repo) + shouldFetchRepositoryHead(existing, incoming).
// The module's import chain instantiates PrismaClient at load, so @/lib/prisma is
// statically mocked (the two functions under test never touch it).

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import {
  createRepositorySyncHash,
  shouldFetchRepositoryHead,
} from "@/services/sync/incremental-sync.service"

function repo(): GitHubRepo {
  return {
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
  }
}

// The GitHubRepo above, but with every key inserted in a different order.
function repoKeysReordered(): GitHubRepo {
  return {
    pushedAt: "2026-01-01T00:00:00Z",
    size: 200,
    license: "MIT",
    isTemplate: false,
    isArchived: false,
    defaultBranch: "main",
    topics: ["api", "demo"],
    forks: 4,
    stars: 50,
    language: "TypeScript",
    homepage: "https://octocat.dev",
    url: "https://github.com/octocat/hello-world",
    fullName: "octocat/hello-world",
    name: "hello-world",
    owner: "octocat",
    description: "A demo repository",
    id: 123,
  }
}

describe("createRepositorySyncHash", () => {
  it("returns a stable hash for identical repository payloads", () => {
    expect(createRepositorySyncHash(repo())).toBe(createRepositorySyncHash(repo()))
  })

  it("is independent of object field insertion order", () => {
    expect(createRepositorySyncHash(repoKeysReordered())).toBe(createRepositorySyncHash(repo()))
  })

  it("ignores stars and forks (engagement metrics do not invalidate the sync hash)", () => {
    expect(createRepositorySyncHash({ ...repo(), stars: 999_999, forks: 42 })).toBe(
      createRepositorySyncHash(repo()),
    )
  })

  const mutationCases: Array<[string, Partial<GitHubRepo>]> = [
    ["description", { description: "completely different description" }],
    ["topics", { topics: ["another", "set"] }],
    ["defaultBranch", { defaultBranch: "develop" }],
    ["pushedAt", { pushedAt: "2027-03-04T05:06:07Z" }],
  ]
  it.each(mutationCases)("changes the hash when %s changes", (_field, changes) => {
    const original = createRepositorySyncHash(repo())
    const mutated = createRepositorySyncHash({ ...repo(), ...changes })
    expect(mutated).not.toBe(original)
    expect(mutated).not.toBe("")
  })
})

describe("shouldFetchRepositoryHead", () => {
  const at = "2026-01-01T00:00:00Z"

  it("returns true when there is no existing sync record", () => {
    expect(shouldFetchRepositoryHead(null, repo())).toBe(true)
  })

  it("returns true when the existing record has no headSha yet (pre-P3 row)", () => {
    expect(
      shouldFetchRepositoryHead(
        { headSha: null, pushedAt: new Date(at), unstarredAt: null },
        repo(),
      ),
    ).toBe(true)
  })

  it("still fetches when the repo has no existing pushedAt (new push signal)", () => {
    expect(
      shouldFetchRepositoryHead(
        { headSha: null, pushedAt: null, unstarredAt: null },
        repo(), // incoming.pushedAt differs from null → fetch
      ),
    ).toBe(true)
  })

  it("returns true for a re-starred repository (unstarredAt set) even if content is unchanged", () => {
    expect(
      shouldFetchRepositoryHead(
        { headSha: "abc123", pushedAt: new Date(at), unstarredAt: new Date(at) },
        repo(),
      ),
    ).toBe(true)
  })

  it("returns true when pushedAt moved forward", () => {
    expect(
      shouldFetchRepositoryHead(
        { headSha: "abc123", pushedAt: new Date(at), unstarredAt: null },
        { ...repo(), pushedAt: "2026-02-01T00:00:00Z" },
      ),
    ).toBe(true)
  })

  it("returns true when pushedAt appears (previously null)", () => {
    expect(
      shouldFetchRepositoryHead(
        { headSha: "abc123", pushedAt: null, unstarredAt: null },
        repo(),
      ),
    ).toBe(true)
  })

  it("returns false when fully unchanged and a headSha already exists", () => {
    expect(
      shouldFetchRepositoryHead(
        { headSha: "abc123", pushedAt: new Date(at), unstarredAt: null },
        repo(),
      ),
    ).toBe(false)
  })

  it("returns false for an unchanged repo with both pushedAt values null", () => {
    expect(
      shouldFetchRepositoryHead(
        { headSha: "abc123", pushedAt: null, unstarredAt: null },
        { ...repo(), pushedAt: null },
      ),
    ).toBe(false)
  })
})