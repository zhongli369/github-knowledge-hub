-- Phase 6.3: Hybrid Search migration
-- Add GENERATED tsvector column + GIN index for full-text search on Repository.
-- Prisma cannot manage GENERATED columns natively — run this SQL manually after `prisma db push`.
--
-- Usage: psql -d github_knowledge_hub -f prisma/migrations/hybrid-search.sql

ALTER TABLE "Repository" ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce("name", '') || ' ' ||
      coalesce("description", '') || ' ' ||
      coalesce(array_to_string("topics", ' '), '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS "Repository_searchVector_idx"
  ON "Repository" USING GIN ("searchVector");
