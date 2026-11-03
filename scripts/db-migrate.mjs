import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import prismaPackage from "@prisma/client"

const { PrismaClient } = prismaPackage
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const initialMigration = "20261103230000_init"
const searchMigration = "20261103231000_repository_search_vector"
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

  const migrations = await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    WHERE migration_name IN ($1, $2)
  `, initialMigration, searchMigration)
  if (
    migrations.length !== 2 ||
    migrations.some((migration) => !migration.finished_at || migration.rolled_back_at)
  ) {
    throw new Error("Prisma migration history does not contain both successful migrations")
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
    "-- CreateIndex",
    'CREATE INDEX "Repository_searchVector_idx" ON "Repository" USING GIN ("searchVector");',
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
    console.log("Verified generated searchVector, GIN index, and successful migration history.")
  }
} finally {
  await prisma.$disconnect()
}
