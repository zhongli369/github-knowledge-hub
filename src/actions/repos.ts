"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import {
  fetchUserRepos,
  fetchStarredRepos,
  syncRepoToDb,
  getUserReposFromDb,
} from "@/services/github"

export async function syncMyRepos() {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const repos = await fetchUserRepos(session.user.id)
  for (const repo of repos) {
    await syncRepoToDb(session.user.id, repo)
  }

  revalidatePath("/repos")
  revalidatePath("/library")
  return repos.length
}

export async function syncStarredRepos() {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const repos = await fetchStarredRepos(session.user.id)
  for (const repo of repos) {
    await syncRepoToDb(session.user.id, repo)
  }

  revalidatePath("/repos")
  revalidatePath("/library")
  return repos.length
}

export async function getMyRepos() {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  return getUserReposFromDb(session.user.id)
}

export async function updateRepoMeta(
  repoId: string,
  data: { note?: string; status?: string }
) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Not authenticated")

  const { prisma } = await import("@/lib/prisma")
  await prisma.repository.updateMany({
    where: { id: repoId, userId: session.user.id },
    data: {
      ...(data.note !== undefined ? { note: data.note } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    },
  })

  revalidatePath("/library")
  revalidatePath(`/library/${repoId}`)
}
