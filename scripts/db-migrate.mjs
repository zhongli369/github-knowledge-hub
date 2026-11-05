import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import prismaPackage from "@prisma/client"

const { PrismaClient } = prismaPackage
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const initialMigration = "20261103230000_init"
const searchMigration = "20261103231000_repository_search_vector"
const workerLeasingMigration = "20261104101530_analysis_worker_leasing"
const repositoryIsolationMigration = "20261104190000_repository_user_isolation"
const autoSyncMigration = "20261105120000_p3_auto_sync"
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js")

if (!process.env.DATABASE_URL && existsSync(path.join(root, ".env"))) {
  process.loadEnvFile(path.join(root, ".env"))
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required")
}

function runPrisma(args, capture = false) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : ""
    throw new Error(`prisma ${args.join(" ")} failed with exit code ${result.status}.${detail}`)
  }
  return result.stdout || ""
}

async function verifyMigratedSchema(prisma) {
  const columns = await prisma.$queryRawUnsafe(`
    SELECT a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS expression
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = 'Repository'
      AND a.attname = 'searchVector' AND NOT a.attisdropped
  `)
  const column = columns[0]
  if (
    column?.attgenerated !== "s" ||
    !column.expression?.includes("to_tsvector") ||
    !column.expression.includes("array_to_string")
  ) {
    throw new Error("Repository.searchVector is not the expected generated stored column")
  }

  const indexes = await prisma.$queryRawUnsafe(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'Repository'
      AND indexname = 'Repository_searchVector_idx'
  `)
  if (!indexes[0]?.indexdef?.includes("USING gin")) {
    throw new Error("Repository_searchVector_idx is missing or is not a GIN index")
  }

  const leasingColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Analysis'
      AND column_name IN ('workerId', 'claimedAt', 'leaseExpiresAt', 'attempts')
  `)
  const expectedLeasingColumns = ["workerId", "claimedAt", "leaseExpiresAt", "attempts"]
  if (
    leasingColumns.length !== expectedLeasingColumns.length ||
    expectedLeasingColumns.some((name) => !leasingColumns.some((column) => column.column_name === name))
  ) {
    throw new Error("Analysis worker leasing columns are missing")
  }

  const leasingIndexes = await prisma.$queryRawUnsafe(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'Analysis'
      AND indexname = 'Analysis_status_leaseExpiresAt_idx'
  `)
  if (leasingIndexes.length !== 1) {
    throw new Error("Analysis_status_leaseExpiresAt_idx is missing")
  }

  const repositoryIndexes = await prisma.$queryRawUnsafe(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'Repository'
      AND indexname IN (
        'Repository_userId_githubId_key',
        'Repository_userId_fullName_key'
      )
  `)
  if (
    repositoryIndexes.length !== 2 ||
    repositoryIndexes.some((index) => !index.indexdef.includes("UNIQUE INDEX"))
  ) {
    throw new Error("Repository per-user unique indexes are missing")
  }

  const activeAnalysisIndexes = await prisma.$queryRawUnsafe(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'Analysis'
      AND indexname = 'Analysis_active_repository_user_type_key'
  `)
  if (
    activeAnalysisIndexes.length !== 1 ||
    !activeAnalysisIndexes[0].indexdef.includes("UNIQUE INDEX") ||
    !activeAnalysisIndexes[0].indexdef.includes("WHERE")
  ) {
    throw new Error("Analysis active-task partial unique index is missing")
  }

  const runningSyncIndexes = await prisma.$queryRawUnsafe(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'SyncRun'
      AND indexname = 'SyncRun_userId_running_key'
  `)
  if (
    runningSyncIndexes.length !== 1 ||
    !runningSyncIndexes[0].indexdef.includes("UNIQUE INDEX") ||
    !runningSyncIndexes[0].indexdef.includes("WHERE")
  ) {
    throw new Error("SyncRun per-user running-task partial unique index is missing")
  }

  const migrations = await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    WHERE migration_name IN ($1, $2, $3, $4, $5)
  `, initialMigration, searchMigration, workerLeasingMigration, repositoryIsolationMigration, autoSyncMigration)
  if (
    migrations.length !== 5 ||
    migrations.some((migration) => !migration.finished_at || migration.rolled_back_at)
  ) {
    throw new Error("Prisma migration history does not contain all five successful migrations")
  }
}

async function assertBaselineEligible(prisma) {
  const history = await prisma.$queryRawUnsafe(`
    SELECT to_regclass('public._prisma_migrations')::text AS table_name
  `)
  if (history[0]?.table_name) {
    throw new Error("Prisma migration history already exists; use npm run db:deploy instead")
  }

  const columns = await prisma.$queryRawUnsafe(`
    SELECT data_type, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Repository'
      AND column_name = 'searchVector'
  `)
  if (columns.length !== 1 || columns[0].data_type !== "tsvector" || columns[0].is_generated !== "NEVER") {
    throw new Error("Baseline requires the legacy plain Repository.searchVector tsvector column")
  }

  const indexes = await prisma.$queryRawUnsafe(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'Repository_searchVector_idx'
  `)
  if (indexes.length !== 0) {
    throw new Error("Legacy search GIN already exists; inspect this database manually before baseline")
  }

  const diff = runPrisma([
    "migrate", "diff",
    "--from-schema-datasource", "prisma/schema.prisma",
    "--to-schema-datamodel", "prisma/schema.prisma",
    "--script",
  ], true).replaceAll("\r\n", "\n").trim()
  const expectedLegacyDiff = [
    "-- DropIndex",
    'DROP INDEX "Repository_fullName_key";',
    "",
    "-- DropIndex",
    'DROP INDEX "Repository_githubId_key";',
    "",
    "-- AlterTable",
    'ALTER TABLE "Analysis" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,',
    'ADD COLUMN     "claimedAt" TIMESTAMP(3),',
    'ADD COLUMN     "contentHash" TEXT,',
    'ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),',
    'ADD COLUMN     "sourceSha" TEXT,',
    'ADD COLUMN     "workerId" TEXT;',
    "",
    "-- AlterTable",
    'ALTER TABLE "KnowledgeAsset" ADD COLUMN     "contentHash" TEXT,',
    'ADD COLUMN     "sourceSha" TEXT;',
    "",
    "-- AlterTable",
    'ALTER TABLE "Repository" ADD COLUMN     "headSha" TEXT,',
    'ADD COLUMN     "starredAt" TIMESTAMP(3),',
    'ADD COLUMN     "syncHash" TEXT,',
    'ADD COLUMN     "unstarredAt" TIMESTAMP(3);',
    "",
    "-- CreateTable",
    'CREATE TABLE "AutomationSettings" (',
    '    "id" TEXT NOT NULL,',
    '    "userId" TEXT NOT NULL,',
    '    "enabled" BOOLEAN NOT NULL DEFAULT false,',
    '    "autoAnalyze" BOOLEAN NOT NULL DEFAULT true,',
    '    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,',
    '    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    "leaseExpiresAt" TIMESTAMP(3),',
    '    "workerId" TEXT,',
    '    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    "updatedAt" TIMESTAMP(3) NOT NULL,',
    "",
    '    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")',
    ');',
    "",
    "-- CreateTable",
    'CREATE TABLE "SyncRun" (',
    '    "id" TEXT NOT NULL,',
    '    "userId" TEXT NOT NULL,',
    '    "trigger" TEXT NOT NULL,',
    '    "status" TEXT NOT NULL,',
    '    "totalCount" INTEGER NOT NULL DEFAULT 0,',
    '    "processedCount" INTEGER NOT NULL DEFAULT 0,',
    '    "addedCount" INTEGER NOT NULL DEFAULT 0,',
    '    "updatedCount" INTEGER NOT NULL DEFAULT 0,',
    '    "unchangedCount" INTEGER NOT NULL DEFAULT 0,',
    '    "unstarredCount" INTEGER NOT NULL DEFAULT 0,',
    '    "failedCount" INTEGER NOT NULL DEFAULT 0,',
    '    "analysisQueuedCount" INTEGER NOT NULL DEFAULT 0,',
    '    "error" TEXT,',
    '    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    "finishedAt" TIMESTAMP(3),',
    '    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    "updatedAt" TIMESTAMP(3) NOT NULL,',
    "",
    '    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")',
    ');',
    "",
    "-- CreateIndex",
    'CREATE UNIQUE INDEX "AutomationSettings_userId_key" ON "AutomationSettings"("userId");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "AutomationSettings_enabled_nextSyncAt_idx" ON "AutomationSettings"("enabled", "nextSyncAt");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "SyncRun_userId_createdAt_idx" ON "SyncRun"("userId", "createdAt");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "SyncRun_status_idx" ON "SyncRun"("status");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "Analysis_status_leaseExpiresAt_idx" ON "Analysis"("status", "leaseExpiresAt");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "Repository_searchVector_idx" ON "Repository" USING GIN ("searchVector");',
    "",
    "-- CreateIndex",
    'CREATE UNIQUE INDEX "Repository_userId_githubId_key" ON "Repository"("userId", "githubId");',
    "",
    "-- CreateIndex",
    'CREATE UNIQUE INDEX "Repository_userId_fullName_key" ON "Repository"("userId", "fullName");',
    "",
    "-- AddForeignKey",
    'ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    "",
    "-- AddForeignKey",
    'ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
  ].join("\n")
  if (diff !== expectedLegacyDiff) {
    throw new Error(`Database differs from the legacy schema in unexpected ways; baseline refused.\n${diff}`)
  }
}

const command = process.argv[2]
const execute = process.argv.includes("--execute")
if (!['deploy', 'baseline'].includes(command)) {
  throw new Error("Usage: node scripts/db-migrate.mjs deploy | baseline [--execute]")
}

const prisma = new PrismaClient()
try {
  if (command === "baseline") {
    await assertBaselineEligible(prisma)
    console.log("Baseline safety checks passed: schema is equivalent and no migration history exists.")
    if (!execute) {
      console.log("Dry run only. Apply with: npm run db:baseline:apply")
    } else {
      runPrisma(["migrate", "resolve", "--applied", initialMigration])
      try {
        runPrisma(["migrate", "deploy"])
      } catch (error) {
        throw new Error(`${error.message}\nInitial migration is baselined; after fixing the issue, run npm run db:deploy.`)
      }
    }
  } else {
    runPrisma(["migrate", "deploy"])
  }

  if (command === "deploy" || execute) {
    await verifyMigratedSchema(prisma)
    console.log("Verified searchVector, leasing fields, per-user repository keys, active-analysis uniqueness, and all migration history.")
  }
} finally {
  await prisma.$disconnect()
}
