import path from "node:path"
import { defineConfig } from "vitest/config"
import { stripShebangPlugin } from "./scripts/vitest-shebang-plugin"

export default defineConfig({
  plugins: [stripShebangPlugin()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
})
