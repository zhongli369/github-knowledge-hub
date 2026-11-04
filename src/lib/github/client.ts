import { Octokit } from "@octokit/rest"
import { retry } from "@octokit/plugin-retry"
import { throttling } from "@octokit/plugin-throttling"
import { prisma } from "@/lib/prisma"
import { decryptToken } from "@/lib/encryption"

const OctokitWithPlugins = Octokit.plugin(retry, throttling)

export async function createOctokit(userId: string): Promise<Octokit> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "github" },
  })

  if (!account?.access_token) {
    throw new Error("No GitHub token found for user")
  }

  let token: string
  try {
    token = decryptToken(account.access_token)
  } catch (error) {
    throw new Error(
      `Failed to decrypt the stored GitHub token for user ${userId}. Reconnect the GitHub account and retry.`,
      { cause: error },
    )
  }

  return new OctokitWithPlugins({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
        console.warn(`Rate limit hit for ${options.method} ${options.url}. Retry after ${retryAfter}s`)
        return true
      },
      onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
        console.warn(`Secondary rate limit hit for ${options.method} ${options.url}. Retry after ${retryAfter}s`)
        return true
      },
    },
  })
}

export function createOctokitWithToken(token: string): Octokit {
  return new OctokitWithPlugins({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
        console.warn(`Rate limit hit for ${options.method} ${options.url}. Retry after ${retryAfter}s`)
        return true
      },
      onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
        console.warn(`Secondary rate limit hit for ${options.method} ${options.url}. Retry after ${retryAfter}s`)
        return true
      },
    },
  })
}
