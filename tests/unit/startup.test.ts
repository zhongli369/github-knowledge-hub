import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const desktop = readFileSync(path.join(process.cwd(), "scripts/start-desktop.ps1"), "utf8")
const legacyDev = readFileSync(path.join(process.cwd(), "scripts/start-dev.ps1"), "utf8")

describe("daily startup safety", () => {
  it.each([
    ["desktop", desktop],
    ["legacy dev", legacyDev],
  ])("never pushes schema or creates extensions in the %s launcher", (_, script) => {
    expect(script).not.toMatch(/prisma(?:\.cmd)?\s+db\s+push/i)
    expect(script).not.toMatch(/CREATE\s+EXTENSION/i)
  })

  it("checks migrations read-only and launches Web plus Worker with separate logs", () => {
    expect(desktop).toContain("prisma validate")
    expect(desktop).toContain("prisma migrate status")
    expect(desktop).toContain('Start-ManagedProcess "worker"')
    expect(desktop).toContain('Start-ManagedProcess "web"')
    expect(desktop).toContain("web.log")
    expect(desktop).toContain("worker.log")
    expect(desktop).toContain("startTimeTicks")
    expect(desktop).toContain("SmokeTest")
  })
})
