import path from "node:path"
import { defineConfig } from "vitest/config"
import { stripShebangPlugin } from "./scripts/vitest-shebang-plugin"

export default defineConfig({
  plugins: [stripShebangPlugin()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
