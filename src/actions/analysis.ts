"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { fetchRepoReadme } from "@/services/github"
import {
  analyzeRepoSummary,
  getRepoAnalysisStatus,
  retryFailedAnalysis,
  AnalysisError,
  type RepoSummary,
  type AnalysisMeta,
  type AnalysisErrorCode,
} from "@/services/llm"

export type { AnalysisMeta, AnalysisErrorCode }

export interface AnalysisActionResult {
  summary: RepoSummary | null
  meta: AnalysisMeta | null
  error: string | null
  errorCode: AnalysisErrorCode | null
}

async function getRepoMeta(userId: string, repoId: string) {
  return prisma.repository.findFirst({
    where: { id: repoId, userId },
    select: {
      id: true,
      name: true,
      fullName: true,
      description: true,
      language: true,
      topics: true,
      stars: true,
      forks: true,
      url: true,
      defaultBranch: true,
      owner: true,
    },
  })
}

// ── Get status (lightweight, no LLM call) ───────────────────────

export async function getRepositoryAnalysisAction(
  repoId: string
): Promise<AnalysisActionResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { summary: null, meta: null, error: "Not authenticated", errorCode: "NOT_AUTHENTICATED" }
  }

  // Verify ownership
  const repo = await getRepoMeta(session.user.id, repoId)
  if (!repo) {
    return { summary: null, meta: null, error: "Repository not found", errorCode: "REPO_NOT_FOUND" }
  }

  const meta = await getRepoAnalysisStatus(repoId, session.user.id)
  return { summary: meta.summary, meta, error: null, errorCode: null }
}

// ── Analyze (generate new or return cached) ─────────────────────

export async function analyzeRepositoryAction(
  repoId: string
): Promise<AnalysisActionResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { summary: null, meta: null, error: "Not authenticated", errorCode: "NOT_AUTHENTICATED" }
  }

  const repo = await getRepoMeta(session.user.id, repoId)
  if (!repo) {
    return { summary: null, meta: null, error: "Repository not found", errorCode: "REPO_NOT_FOUND" }
  }

  try {
    const readme = await fetchRepoReadme(session.user.id, repo.owner, repo.name)

    const result = await analyzeRepoSummary(
      repoId,
      session.user.id,
      {
        name: repo.name,
        fullName: repo.fullName,
        description: repo.description,
        language: repo.language,
        topics: repo.topics,
        stars: repo.stars,
        forks: repo.forks,
        url: repo.url,
        defaultBranch: repo.defaultBranch,
      },
      readme
    )

    const meta = await getRepoAnalysisStatus(repoId, session.user.id)
    return { summary: result.summary, meta, error: null, errorCode: null }
  } catch (error) {
    if (error instanceof AnalysisError) {
      return { summary: null, meta: null, error: error.message, errorCode: error.code }
    }
    const msg = error instanceof Error ? error.message : "Analysis failed"
    return { summary: null, meta: null, error: msg, errorCode: "UNKNOWN" }
  }
}

// ── Retry (only for failed) ─────────────────────────────────────

export async function retryAnalysisAction(
  repoId: string
): Promise<AnalysisActionResult> {
  const session = await auth()
  if (!session?.user?.id) {
    return { summary: null, meta: null, error: "Not authenticated", errorCode: "NOT_AUTHENTICATED" }
  }

  const repo = await getRepoMeta(session.user.id, repoId)
  if (!repo) {
    return { summary: null, meta: null, error: "Repository not found", errorCode: "REPO_NOT_FOUND" }
  }

  try {
    const readme = await fetchRepoReadme(session.user.id, repo.owner, repo.name)

    const result = await retryFailedAnalysis(
      repoId,
      session.user.id,
      {
        name: repo.name,
        fullName: repo.fullName,
        description: repo.description,
        language: repo.language,
        topics: repo.topics,
        stars: repo.stars,
        forks: repo.forks,
        url: repo.url,
        defaultBranch: repo.defaultBranch,
      },
      readme
    )

    const meta = await getRepoAnalysisStatus(repoId, session.user.id)
    return { summary: result.summary, meta, error: null, errorCode: null }
  } catch (error) {
    if (error instanceof AnalysisError) {
      return { summary: null, meta: null, error: error.message, errorCode: error.code }
    }
    const msg = error instanceof Error ? error.message : "Retry failed"
    return { summary: null, meta: null, error: msg, errorCode: "UNKNOWN" }
  }
}
