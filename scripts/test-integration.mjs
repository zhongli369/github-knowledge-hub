import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
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

const integrationTestDir = path.join(root, "tests", "integration")
const integrationTestFiles = readdirSync(integrationTestDir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
if (integrationTestFiles.length === 0) {
  throw new Error(`No integration test files found in ${integrationTestDir}`)
}

/**
 * Every integration test file runs against its OWN freshly-created database.
 * Files share nothing, so a failed or mid-run suite can never pollute the next
 * file's assertions. Database names keep the `gkh_test_<label>_<digits>_<digits>`
 * shape that the integration suites' safety guards validate.
 */
function dbName(label, runSegment = runId) {
  return `gkh_test_${label}_${runSegment}`
}

function dbUrl(name) {
  const url = new URL(baseUrl)
  url.pathname = `/${name}`
  return url.toString()
}

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

function createDatabase(label, runSegment = runId) {
  const name = dbName(label, runSegment)
  dockerDatabase("createdb", name)
  createdDatabases.push(name)
  return { name, url: dbUrl(name) }
}

/** Clones the already-migrated fresh template so all files share one migration deploy. */
function cloneFreshDatabase(template, index) {
  const name = dbName("fresh", `${Date.now()}${String(index + 1).padStart(2, "0")}_${process.pid}`)
  if (!/^gkh_test_fresh_\d+_\d+$/.test(name)) {
    throw new Error(`Refusing unexpected fresh test database name: ${name}`)
  }
  run("docker", ["exec", container, "createdb", "-U", databaseUser, "-T", template.name, name])
  createdDatabases.push(name)
  return { name, url: dbUrl(name) }
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
  // 1) One fresh "template" database that receives the real Prisma migrations.
  const template = createDatabase("fresh")
  run(process.execPath, ["scripts/db-migrate.mjs", "deploy"], environmentFor(template))

  // 2) Every integration test file gets its own clone so suites are fully
  //    isolated from each other (no shared rows, no cross-file pollution).
  const fileDatabases = new Map()
  integrationTestFiles.forEach((file, index) => {
    const database = cloneFreshDatabase(template, index)
    fileDatabases.set(path.join("tests", "integration", file), database)
  })

  // 3) The legacy database is derived, pushed, seeded and baselined once.
  const legacy = createDatabase("legacy")
  const runtimeDir = path.join(root, ".run")
  mkdirSync(runtimeDir, { recursive: true })
  legacySchemaPath = path.join(runtimeDir, `legacy-schema-${runId}.prisma`)
  const currentSchema = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8")
  const legacySchema = currentSchema
    // Recreate the pre-user-isolation identity constraints. The upgrade
    // migration must be rehearsed from the actual old global uniques, not from
    // a database that already has the new compound keys.
    .replace(/^  githubId\s+Int\r?$/m, "  githubId        Int              @unique")
    .replace(/^  fullName\s+String\r?$/m, "  fullName        String           @unique")
    .replace(/^  @@unique\(\[userId, (?:githubId|fullName)\]\)\r?\n/gm, "")
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
    legacySchema.includes("@@index([status, leaseExpiresAt]") ||
    legacySchema.includes("@@unique([userId, githubId]") ||
    !legacySchema.includes("githubId        Int              @unique") ||
    !legacySchema.includes("fullName        String           @unique")
  ) {
    throw new Error("Could not derive the legacy Prisma schema fixture")
  }
  writeFileSync(legacySchemaPath, legacySchema, "utf8")
  run(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--schema", legacySchemaPath], environmentFor(legacy))
  await seedLegacyDatabase(legacy)
  run(process.execPath, ["scripts/db-migrate.mjs", "baseline", "--execute"], environmentFor(legacy))

  // 4) Run each integration test file serially against its own database. A
  //    failure in one file aborts nothing; the remaining suites still run and
  //    the overall exit code reflects any file that failed.
  for (const file of integrationTestFiles) {
    const filePath = path.join("tests", "integration", file)
    const database = fileDatabases.get(filePath)
    if (!database) throw new Error(`No isolated database was prepared for ${filePath}`)
    const testEnvironment = {
      ...environmentFor(database),
      GKH_TEST_FRESH_DATABASE_URL: database.url,
      GKH_TEST_LEGACY_DATABASE_URL: legacy.url,
      GKH_TEST_RUNTIME_ID: runId,
    }
    try {
      run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts", filePath], testEnvironment)
    } catch (error) {
      console.error(`\nIntegration test file failed: ${file}\n${error.message}`)
      exitCode = 1
    }
  }
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
