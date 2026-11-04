import { prisma } from "@/lib/prisma"

/**
 * Repository ownership guard for the intake / enqueue layer (P1 Agent A).
 *
 * Every enqueue path must verify that the target repository exists and belongs
 * to the acting user before creating a pending Analysis row. This is the single
 * chokepoint so an illegal `repositoryId` (missing, or owned by another user)
 * can never be queued or written to.
 *
 * The analysis worker (P1 Agent B) can reuse `assertRepositoryOwned` as the
 * pre-execution `repository.userId === analysis.userId` check: passing the
 * claimed task's `repositoryId` + `userId` throws unless the repository is
 * owned by that user.
 */

export const REPOSITORY_NOT_OWNED_MESSAGE =
  "Repository not found or not owned by this user"

/**
 * Thrown when a caller tries to queue or execute work against a repository that
 * does not exist or is not owned by them.
 */
export class RepositoryNotOwnedError extends Error {
  constructor(message: string = REPOSITORY_NOT_OWNED_MESSAGE) {
    super(message)
    this.name = "RepositoryNotOwnedError"
  }
}

export interface OwnedRepositoryMeta {
  id: string
  owner: string
  name: string
  fullName: string
}

/**
 * Return the repository's ownership metadata when `repoId` exists and belongs to
 * `userId`, otherwise `null`. Never throws; callers decide how to surface the denial.
 */
export async function getOwnedRepositoryMeta(
  repoId: string,
  userId: string
): Promise<OwnedRepositoryMeta | null> {
  if (!repoId || !userId) return null

  return prisma.repository.findFirst({
    where: { id: repoId, userId },
    select: { id: true, owner: true, name: true, fullName: true },
  })
}

/**
 * Fail-fast variant of `getOwnedRepositoryMeta`: throws `RepositoryNotOwnedError`
 * when the repository is missing or not owned by the user. Suitable for guards
 * that must abort (e.g. the analysis worker before executing a claimed task).
 */
export async function assertRepositoryOwned(
  repoId: string | null | undefined,
  userId: string
): Promise<OwnedRepositoryMeta> {
  if (!repoId) throw new RepositoryNotOwnedError()

  const repo = await getOwnedRepositoryMeta(repoId, userId)
  if (!repo) throw new RepositoryNotOwnedError()
  return repo
}