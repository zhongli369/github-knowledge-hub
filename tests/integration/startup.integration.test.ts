import { existsSync, readFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    // Match Next.js's wildcard bind; an IPv4-only probe can miss an IPv6 listener.
    server.listen(0, "::", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Could not allocate a smoke test port"))
        return
      }
      const { port } = address
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

describe("desktop launcher smoke test", () => {
  it("starts and stops isolated Web and Worker processes without touching the real database", async () => {
    const databaseUrl = process.env.GKH_TEST_FRESH_DATABASE_URL!
    const runId = process.env.GKH_TEST_RUNTIME_ID!
    const port = await availablePort()
    const runtimeDir = path.join(process.cwd(), ".run", `smoke-${runId}`)
    const logDir = path.join(process.cwd(), "logs", `smoke-${runId}`)
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "scripts/start-desktop.ps1",
        "-NoBrowser", "-SmokeTest", "-Port", String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          GKH_RUNTIME_DIR: runtimeDir,
          GKH_LOG_DIR: logDir,
        },
        encoding: "utf8",
        timeout: 180_000,
      },
    )

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("Smoke test passed")
    expect(result.stdout).not.toContain("prisma db push")
    expect(existsSync(path.join(runtimeDir, "web.json"))).toBe(false)
    expect(existsSync(path.join(runtimeDir, "worker.json"))).toBe(false)
    expect(readFileSync(path.join(logDir, "worker.log"), "utf8")).toContain("Analysis worker started")
    expect(readFileSync(path.join(logDir, "web.log"), "utf8")).toContain("Next.js")
  })
})
