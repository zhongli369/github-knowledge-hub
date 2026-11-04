import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import prismaPackage from "@prisma/client"

const { PrismaClient } = prismaPackage
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js")

if (!process.env.DATABASE_URL && existsSync(path.join(root, ".env"))) {
  process.loadEnvFile(path.join(root, ".env"))
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to derive isolated test databases")

const baseUrl = new URL(process.env.DATABASE_URL)
if (!["postgresql:", "postgres:"].includes(baseUrl.protocol)) {
  throw new Error("Integration tests require a PostgreSQL DATABASE_URL")
}
if (!["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname)) {
  throw new Error("Integration tests only allow a local PostgreSQL server")
}
const databaseUser = decodeURIComponent(baseUrl.username)
if (!/^[A-Za-z0-9_]+$/.test(databaseUser)) {
  throw new Error("Integration test database user contains unsupported characters")
}
const container = process.env.GKH_TEST_CONTAINER || "github-knowledge-hub-db"
const runId = `${Date.now()}_${process.pid}`
const createdDatabases = []
let legacySchemaPath = null

function run(command, args, env = process.env) {
  console.log(`\n> ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`)
}

function dockerDatabase(tool, databaseName) {
  if (!/^gkh_test_[a-z]+_\d+_\d+$/.test(databaseName)) {
    throw new Error(`Refusing unexpected test database name: ${databaseName}`)
  }
  run("docker", ["exec", container, tool, "-U", databaseUser, databaseName])
}

function createDatabase(label) {
  const name = `gkh_test_${label}_${runId}`
  const url = new URL(baseUrl)
  url.pathname = `/${name}`
  dockerDatabase("createdb", name)
  createdDatabases.push(name)
  return { name, url: url.toString() }
}

function environmentFor(database) {
  return { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" }
}

async function seedLegacyDatabase(database) {
  const prisma = new PrismaClient({ datasources: { db: { url: database.url } } })
  const now = new Date("2026-01-01T00:00:00.000Z")
  try {
    await prisma.user.create({ data: { id: "legacy-user", name: "Legacy User", updatedAt: now } })
    await prisma.repository.create({
      data: {
        id: "legacy-repo",
        githubId: 42,
        owner: "legacy",
        name: "PostgreSQL Handbook",
        fullName: "legacy/postgresql-handbook",
        description: "Legacy search data",
        url: "https://example.invalid/legacy/postgresql-handbook",
        language: "TypeScript",
        stars: 7,
        topics: ["database", "search"],
        userId: "legacy-user",
        createdAt: now,
        updatedAt: now,
      },
    })
    // The current generated Client includes P1 columns in Analysis writes.
    // Seed the pre-P1 schema with explicit legacy columns instead.
    await prisma.$executeRaw`
      INSERT INTO "Analysis"
        ("id", "analysisType", "status", "repositoryId", "userId", "createdAt", "updatedAt")
      VALUES
        ('legacy-analysis', 'repo_summary', 'completed', 'legacy-repo', 'legacy-user', ${now}, ${now}),
        ('legacy-running-analysis', 'asset_extraction', 'running', 'legacy-repo', 'legacy-user', ${now}, ${now})
    `
  } finally {
    await prisma.$disconnect()
  }
}

let exitCode = 0
try {
  const fresh = createDatabase("fresh")
  run(process.execPath, ["scripts/db-migrate.mjs", "deploy"], environmentFor(fresh))

  const legacy = createDatabase("legacy")
  const runtimeDir = path.join(root, ".run")
  mkdirSync(runtimeDir, { recursive: true })
  legacySchemaPath = path.join(runtimeDir, `legacy-schema-${runId}.prisma`)
  const currentSchema = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8")
  const legacySchema = currentSchema
    .replace(
      /  \/\/ Stored generated column[^\n]*\n  searchVector[^\n]*/,
      '  searchVector    Unsupported("tsvector")?',
    )
    .replace(/^  @@index\(\[searchVector\], type: Gin\)\r?\n/m, "")
    .replace(
      /^  \/\/ ── Worker leasing \(P1 Agent B\)[\s\S]*?^  attempts\s+Int\s+@default\(0\)\r?\n/m,
      "",
    )
    .replace(/^  @@index\(\[status, leaseExpiresAt\]\)\r?\n/m, "")
  if (
    legacySchema === currentSchema ||
    legacySchema.includes("@@index([searchVector]") ||
    legacySchema.includes("leaseExpiresAt") ||
    legacySchema.includes("@@index([status, leaseExpiresAt]")
  ) {
    throw new Error("Could not derive the legacy Prisma schema fixture")
  }
  writeFileSync(legacySchemaPath, legacySchema, "utf8")
  run(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--schema", legacySchemaPath], environmentFor(legacy))
  await seedLegacyDatabase(legacy)
  run(process.execPath, ["scripts/db-migrate.mjs", "baseline", "--execute"], environmentFor(legacy))

  const testEnvironment = {
    ...environmentFor(fresh),
    GKH_TEST_FRESH_DATABASE_URL: fresh.url,
    GKH_TEST_LEGACY_DATABASE_URL: legacy.url,
    GKH_TEST_RUNTIME_ID: runId,
  }
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"], testEnvironment)
} catch (error) {
  console.error(`\nIntegration test failure: ${error.message}`)
  exitCode = 1
} finally {
  if (legacySchemaPath && existsSync(legacySchemaPath)) unlinkSync(legacySchemaPath)
  for (const databaseName of createdDatabases.reverse()) {
    const result = spawnSync("docker", ["exec", container, "dropdb", "-U", databaseUser, "--if-exists", databaseName], {
      cwd: root,
      stdio: "inherit",
    })
    if (result.status !== 0) {
      console.error(`Could not remove isolated test database ${databaseName}; inspect it manually.`)
      exitCode = 1
    }
  }
}
process.exitCode = exitCode
