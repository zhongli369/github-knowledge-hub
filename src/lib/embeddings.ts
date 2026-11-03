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
