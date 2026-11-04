-- P1 (Agent B): Analysis worker leasing fields.
--
-- Each analysis row now records which worker identity owns the current lease
-- (workerId), when that lease was acquired (claimedAt), when it expires
-- (leaseExpiresAt), and how many times the task has been claimed (attempts).
--
-- Claim rules enforced by the worker leasing service (raw SQL, not here):
--   * "pending" tasks are claimable.
--   * "running" tasks whose lease has expired are reclaimable.
--   * attempts is bounded by the worker's MAX_ATTEMPTS so a poisoned task
--     reaches terminal "failed" instead of looping forever.
-- All four columns are additive; existing rows default to unattempted/unclaimed
-- so the current Web status flow (pending -> running -> completed/failed)
-- remains unchanged.

ALTER TABLE "Analysis" ADD COLUMN "workerId" TEXT;

ALTER TABLE "Analysis" ADD COLUMN "claimedAt" TIMESTAMP(3);

ALTER TABLE "Analysis" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "Analysis" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- Rows left "running" by the pre-lease worker have no lease timestamp. Give
-- them an already-expired lease so the new worker can recover them instead of
-- leaving them stuck forever. Stop old workers before deploying this migration.
UPDATE "Analysis"
SET "claimedAt" = "updatedAt", "leaseExpiresAt" = "updatedAt"
WHERE "status" = 'running';

-- Speeds up the claim scan: pending tasks and expired leases are the two
-- claimable buckets, so an index leading on status keeps the scan small.
CREATE INDEX "Analysis_status_leaseExpiresAt_idx" ON "Analysis"("status", "leaseExpiresAt");

-- NOTE (knowledge asset idempotency): a reclaimed asset_extraction task must
-- never produce duplicate KnowledgeAsset rows. The dedup contract is already
-- provided by the unique index `KnowledgeAsset_repositoryId_sourcePath_key`
-- created by the init migration:
--
--   CREATE UNIQUE INDEX "KnowledgeAsset_repositoryId_sourcePath_key"
--     ON "KnowledgeAsset"("repositoryId", "sourcePath");
--
-- plus `extractFromFile`/`extractWithLLM` swallowing the resulting Prisma P2002.
-- That index intentionally lives in the init migration (it is load-bearing for
-- ANY extraction, not just leasing) and is NOT re-created here because a second
-- UNIQUE index on the same pair would fail to deploy after init. PostgreSQL's
-- NULL semantics are unaffected: multiple rows with the same repositoryId but
-- NULL sourcePath remain allowed.
--
-- If a pre-existing deployed database is suspected of duplicate
-- (repositoryId, sourcePath) pairs, the main agent must reconcile those BEFORE
-- deploying: the init migration would already have been applied, so any real
-- duplicates indicate drift to be audited manually rather than by this migration.