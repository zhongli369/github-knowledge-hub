import { spawnSync } from "node:child_process"
import path from "node:path"
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"

function testDatabaseUrl(variable: string): string {
  const value = process.env[variable]
  if (!value) throw new Error(`${variable} is required`)
  const databaseName = new URL(value).pathname.slice(1)
  if (!/^gkh_test_[a-z]+_\d+_\d+$/.test(databaseName)) {
    throw new Error(`${variable} must point to an isolated gkh_test_* database`)
  }
  return value
}

const freshUrl = testDatabaseUrl("GKH_TEST_FRESH_DATABASE_URL")
const legacyUrl = testDatabaseUrl("GKH_TEST_LEGACY_DATABASE_URL")
const fresh = new PrismaClient({ datasources: { db: { url: freshUrl } } })
const legacy = new PrismaClient({ datasources: { db: { url: legacyUrl } } })

afterAll(async () => {
  await Promise.all([fresh.$disconnect(), legacy.$disconnect()])
})

async function businessSchema(prisma: PrismaClient) {
  const columns = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT table_name, column_name, ordinal_position, data_type, udt_name,
      is_nullable, column_default, is_generated, generation_expression
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name != '_prisma_migrations'
    ORDER BY table_name, column_name, ordinal_position
  `)
  const indexes = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
    ORDER BY tablename, indexname
  `)
  const constraints = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT conrelid::regclass::text AS table_name, conname, contype::text,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid::regclass::text != '_prisma_migrations'
    ORDER BY conrelid::regclass::text, conname
  `)
  return { columns, indexes, constraints }
}

describe("Prisma migrations in isolated databases", () => {
  it("creates identical business schemas from fresh deploy and legacy baseline", async () => {
    expect(await businessSchema(legacy)).toEqual(await businessSchema(fresh))
  })

  it("records both migrations and creates generated searchVector plus GIN", async () => {
    for (const prisma of [fresh, legacy]) {
      const migrations = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(`
        SELECT migration_name FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name
      `)
      expect(migrations.map((row) => row.migration_name)).toEqual([
        "20261103230000_init",
        "20261103231000_repository_search_vector",
      ])

      const generated = await prisma.$queryRawUnsafe<Array<{ attgenerated: string; expression: string }>>(`
        SELECT a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS expression
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'Repository'
          AND a.attname = 'searchVector' AND NOT a.attisdropped
      `)
      expect(generated).toHaveLength(1)
      expect(generated[0].attgenerated).toBe("s")
      expect(generated[0].expression).toContain("to_tsvector")

      const index = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'Repository_searchVector_idx'
      `)
      expect(index[0]?.indexdef).toContain("USING gin")
    }
  })

  it("preserves legacy business records and derives their search text", async () => {
    const repository = await legacy.repository.findUniqueOrThrow({ where: { id: "legacy-repo" } })
    expect(repository).toMatchObject({
      githubId: 42,
      fullName: "legacy/postgresql-handbook",
      description: "Legacy search data",
      language: "TypeScript",
      stars: 7,
      topics: ["database", "search"],
      userId: "legacy-user",
    })
    expect(await legacy.user.count()).toBe(1)
    expect(await legacy.analysis.count()).toBe(1)

    const matches = await legacy.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT id FROM "Repository"
      WHERE "searchVector" @@ websearch_to_tsquery('english', 'PostgreSQL')
    `)
    expect(matches).toEqual([{ id: "legacy-repo" }])
  })

  it("keeps both vector columns at 1536 dimensions", async () => {
    const columns = await fresh.$queryRawUnsafe<Array<{ table_name: string; type: string }>>(`
      SELECT c.relname AS table_name, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('Embedding', 'RepoEmbedding')
        AND a.attname = 'vector' AND NOT a.attisdropped
      ORDER BY c.relname
    `)
    expect(columns).toEqual([
      { table_name: "Embedding", type: "vector(1536)" },
      { table_name: "RepoEmbedding", type: "vector(1536)" },
    ])
  })

  it.each([
    ["fresh", freshUrl],
    ["legacy", legacyUrl],
  ])("reports no Prisma schema drift after %s migration", (_, databaseUrl) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules", "prisma", "build", "index.js"),
        "migrate", "diff",
        "--from-schema-datasource", "prisma/schema.prisma",
        "--to-schema-datamodel", "prisma/schema.prisma",
        "--script",
      ],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe("-- This is an empty migration.")
  })
})
