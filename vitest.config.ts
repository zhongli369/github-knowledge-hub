import path from "node:path"
import { defineConfig } from "vitest/config"
import { stripShebangPlugin } from "./scripts/vitest-shebang-plugin"

export default defineConfig({
  plugins: [stripShebangPlugin()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: [
      "tests/unit/**/*.test.ts",
      "tests/collections/**/*.test.ts",
      "tests/classification/**/*.test.ts",
      "tests/classification-integration/**/*.test.ts",
      "workers/**/*.test.ts",
    ],
    environment: "node",
  },
})
