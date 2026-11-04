import type { Plugin } from "vite"

/**
 * Vitest's vite-node executors run transformed modules through
 * `new AsyncFunction` / `new Function`, which — unlike Node's native ESM
 * loader — does NOT strip a leading `#!` shebang. A shebang at the top of a
 * transformed `.mjs` script therefore becomes an invalid token and breaks test
 * collection (`SyntaxError: Invalid or unexpected token`) on every platform
 * where the executor path is used. The same file works when run with plain
 * `node` (native ESM strips it), which is why direct imports and clean CI can
 * pass while local Vitest collection fails.
 *
 * This transform removes a leading shebang from `.mjs` sources before Vite's
 * esbuild step runs, so the transformed output is always clean ESM. Shebangs
 * are only meaningful for direct CLI execution (`node script.mjs`) and never
 * for imported modules.
 */
export function stripShebangPlugin(): Plugin {
  return {
    name: "strip-shebang-from-mjs",
    transform(code, id) {
      if (id.endsWith(".mjs") && code.startsWith("#!")) {
        const newline = code.indexOf("\n")
        if (newline !== -1) return code.slice(newline + 1)
      }
      return undefined
    },
  }
}