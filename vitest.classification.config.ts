import path from "node:path"
import { defineConfig } from "vitest/config"
import { stripShebangPlugin } from "./scripts/vitest-shebang-plugin"

/**
 * Config for the Agent D classification suites:
 *   - tests/classification-integration/ — sync-trigger, batch actions,
 *     progress, worker-to-classifier contract (all with mocked LLM/DB).
 *   - workers/analysis-worker.*.test.ts — worker classification handlers.
 *
 * These are mocked (no external LLM, no Postgres), so they run in the Node
 * environment like the unit suite. Real isolated-DB integration is handled by
 * the main agent via the existing tests/integration harness.
 */
export default defineConfig({
  plugins: [stripShebangPlugin()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: [
      "tests/classification-integration/**/*.test.ts",
      "workers/**/*.test.ts",
    ],
    environment: "node",
  },
})