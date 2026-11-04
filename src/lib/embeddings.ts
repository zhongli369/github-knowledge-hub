import OpenAI from "openai"

const globalForEmbeddings = globalThis as unknown as { embeddingsOpenAI?: OpenAI }

export const embeddingsOpenAI =
  globalForEmbeddings.embeddingsOpenAI ??
  new OpenAI({
    apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  })

if (process.env.NODE_ENV !== "production") {
  globalForEmbeddings.embeddingsOpenAI = embeddingsOpenAI
}

/**
 * Classifies whether an error thrown during embedding generation means the
 * embedding provider is missing/unavailable (rather than a generic query or
 * database failure). Lets the UI show a specific, actionable prompt.
 */
export function isEmbeddingUnavailableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message
    if (
      /apiKey|API key|OPENAI_API_KEY|EMBEDDING_API_KEY|Unauthenticated|\b401\b/.test(msg)
    ) {
      return true
    }
  }
  return false
}
