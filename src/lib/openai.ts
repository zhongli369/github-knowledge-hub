// TODO(Phase 5): OpenAI client stub — not yet wired into the main flow.
// Will be used for LLM analysis and embeddings once repo/library E2E is verified.

import OpenAI from "openai"

const globalForOpenAI = globalThis as unknown as { openai?: OpenAI }

export const openai =
  globalForOpenAI.openai ??
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  })

if (process.env.NODE_ENV !== "production") {
  globalForOpenAI.openai = openai
}
