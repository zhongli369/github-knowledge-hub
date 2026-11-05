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
const repositoryCategoriesMigration = "20261105120000_repository_function_categories"
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

  const categoryColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Collection'
      AND column_name IN ('kind', 'slug')
  `)
  if (categoryColumns.length !== 2) {
    throw new Error("Collection functional-category columns are missing")
  }

  const categoryIndexes = await prisma.$queryRawUnsafe(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN (
      'Collection_userId_kind_idx',
      'Collection_userId_slug_key',
      'CollectionRepository_collectionId_excluded_idx',
      'CollectionRepository_repositoryId_excluded_idx',
      'CollectionRepository_collectionId_repositoryId_key',
      'RepositoryClassification_userId_status_idx'
    )
  `)
  if (categoryIndexes.length !== 6) {
    throw new Error("Repository functional-category indexes are missing")
  }

  const migrations = await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    WHERE migration_name IN ($1, $2, $3, $4, $5)
  `, initialMigration, searchMigration, workerLeasingMigration, repositoryIsolationMigration, repositoryCategoriesMigration)
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
    'ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),',
    'ADD COLUMN     "workerId" TEXT;',
    "",
    "-- AlterTable",
    'ALTER TABLE "Collection" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT \'custom\',',
    'ADD COLUMN     "slug" TEXT;',
    "",
    "-- CreateTable",
    'CREATE TABLE "CollectionRepository" (',
    '    "id" TEXT NOT NULL,',
    '    "collectionId" TEXT NOT NULL,',
    '    "repositoryId" TEXT NOT NULL,',
    '    "source" TEXT NOT NULL DEFAULT \'auto\',',
    '    "excluded" BOOLEAN NOT NULL DEFAULT false,',
    '    "confidence" DOUBLE PRECISION,',
    '    "reason" TEXT,',
    '    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    "updatedAt" TIMESTAMP(3) NOT NULL,',
    "",
    '    CONSTRAINT "CollectionRepository_pkey" PRIMARY KEY ("id")',
    ');',
    "",
    "-- CreateTable",
    'CREATE TABLE "RepositoryClassification" (',
    '    "repositoryId" TEXT NOT NULL,',
    '    "userId" TEXT NOT NULL,',
    '    "contentHash" TEXT NOT NULL,',
    '    "classifierVersion" TEXT NOT NULL,',
    '    "status" TEXT NOT NULL,',
    '    "categorySlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],',
    '    "error" TEXT,',
    '    "classifiedAt" TIMESTAMP(3),',
    '    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '    "updatedAt" TIMESTAMP(3) NOT NULL,',
    "",
    '    CONSTRAINT "RepositoryClassification_pkey" PRIMARY KEY ("repositoryId")',
    ');',
    "",
    "-- CreateIndex",
    'CREATE INDEX "CollectionRepository_collectionId_excluded_idx" ON "CollectionRepository"("collectionId", "excluded");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "CollectionRepository_repositoryId_excluded_idx" ON "CollectionRepository"("repositoryId", "excluded");',
    "",
    "-- CreateIndex",
    'CREATE UNIQUE INDEX "CollectionRepository_collectionId_repositoryId_key" ON "CollectionRepository"("collectionId", "repositoryId");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "RepositoryClassification_userId_status_idx" ON "RepositoryClassification"("userId", "status");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "Analysis_status_leaseExpiresAt_idx" ON "Analysis"("status", "leaseExpiresAt");',
    "",
    "-- CreateIndex",
    'CREATE INDEX "Collection_userId_kind_idx" ON "Collection"("userId", "kind");',
    "",
    "-- CreateIndex",
    'CREATE UNIQUE INDEX "Collection_userId_slug_key" ON "Collection"("userId", "slug");',
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
    'ALTER TABLE "CollectionRepository" ADD CONSTRAINT "CollectionRepository_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    "",
    "-- AddForeignKey",
    'ALTER TABLE "CollectionRepository" ADD CONSTRAINT "CollectionRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    "",
    "-- AddForeignKey",
    'ALTER TABLE "RepositoryClassification" ADD CONSTRAINT "RepositoryClassification_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    "",
    "-- AddForeignKey",
    'ALTER TABLE "RepositoryClassification" ADD CONSTRAINT "RepositoryClassification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
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
    console.log("Verified searchVector, leasing fields, per-user repository keys, active-analysis uniqueness, functional-category schema, and all migration history.")
  }
} finally {
  await prisma.$disconnect()
}
