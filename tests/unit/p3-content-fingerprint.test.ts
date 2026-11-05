import { describe, expect, it } from "vitest"

// ── P3 analysis content fingerprint (pure function, no DB / network) ──
// Contract: createAnalysisContentHash({ metadata, readme }) → SHA-256 hex.
// The hash must reflect content (README / description / language / topics order)
// but must NOT change when engagement metrics (stars / forks) change.

import { createAnalysisContentHash } from "@/services/analysis/content-fingerprint"

const SHA256_HEX = /^[a-f0-9]{64}$/

describe("createAnalysisContentHash output format", () => {
  it("is a 64-character lowercase SHA-256 hex digest", () => {
    const hash = createAnalysisContentHash({
      metadata: { description: "demo", language: "TypeScript" },
      readme: "# Hello",
    })
    expect(hash).toMatch(SHA256_HEX)
    expect(hash).toHaveLength(64)
  })

  it("is deterministic for identical inputs", () => {
    const input = {
      metadata: { description: "demo", language: "TypeScript", topics: ["a", "b"] },
      readme: "# Hello\n\nBody.\n",
    }
    expect(createAnalysisContentHash(input)).toBe(createAnalysisContentHash(input))
    // A structurally equal but newly-built object must hash identically too.
    expect(createAnalysisContentHash(input)).toBe(
      createAnalysisContentHash({
        metadata: { topics: ["a", "b"], language: "TypeScript", description: "demo" },
        readme: "# Hello\n\nBody.\n",
      }),
    )
  })
})

describe("createAnalysisContentHash stability rules", () => {
  const base = {
    metadata: {
      description: "A demo repository",
      language: "TypeScript",
      topics: ["api", "demo"],
    },
    readme: "# Hello World\n\nThe official demo.\n",
  }

  it("is independent of object field insertion order in metadata", () => {
    expect(createAnalysisContentHash(base)).toBe(
      createAnalysisContentHash({
        metadata: {
          topics: ["api", "demo"],
          description: "A demo repository",
          language: "TypeScript",
        },
        readme: base.readme,
      }),
    )
  })

  it("is sensitive to array order inside metadata (topics order matters)", () => {
    const reorderedTopics = createAnalysisContentHash({
      ...base,
      metadata: { ...base.metadata, topics: ["demo", "api"] },
    })
    expect(reorderedTopics).not.toBe(createAnalysisContentHash(base))
  })

  it("does not change when stars / forks move", () => {
    const withEngagement = createAnalysisContentHash({
      ...base,
      metadata: { ...base.metadata, stars: 999_999, forks: 42 },
    })
    expect(withEngagement).toBe(createAnalysisContentHash(base))
  })

  it("changes when description changes", () => {
    const changed = createAnalysisContentHash({
      ...base,
      metadata: { ...base.metadata, description: "Now with a completely new description" },
    })
    expect(changed).not.toBe(createAnalysisContentHash(base))
  })

  it("changes when language changes", () => {
    const changed = createAnalysisContentHash({
      ...base,
      metadata: { ...base.metadata, language: "Rust" },
    })
    expect(changed).not.toBe(createAnalysisContentHash(base))
  })

  it("changes when the README changes", () => {
    const changed = createAnalysisContentHash({ ...base, readme: "# Different\n" })
    expect(changed).not.toBe(createAnalysisContentHash(base))
  })

  it("distinguishes a null README from an empty-string README", () => {
    const noReadme = createAnalysisContentHash({ ...base, readme: null })
    const emptyReadme = createAnalysisContentHash({ ...base, readme: "" })
    expect(noReadme).toMatch(SHA256_HEX)
    expect(emptyReadme).toMatch(SHA256_HEX)
    expect(noReadme).not.toBe(emptyReadme)
  })

  it("distinguishes a missing readme key from an empty string when structurally compared", () => {
    // Both omit a README is out of contract scope; this guards the stable-serialization
    // behavior: JSON.null and JSON "" must serialize differently.
    const nullHash = createAnalysisContentHash({ metadata: { description: "x" }, readme: null })
    const emptyHash = createAnalysisContentHash({
      metadata: { description: "x" },
      readme: "",
    })
    expect(nullHash).not.toBe(emptyHash)
  })
})