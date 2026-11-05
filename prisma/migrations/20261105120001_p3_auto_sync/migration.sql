-- P3 (Agent: Prisma schema + incremental sync). Auto-sync run tracking and
-- sync provenance.
--
-- The incremental sync and the AI auto-analyze feature share this contract.
-- All Repository/Analysis/KnowledgeAsset columns are additive and nullable so
-- existing rows keep working unchanged:
--
--   * Repository.headSha / syncHash  - last observed default-branch HEAD SHA and
--     the stable content fingerprint. The incremental sync uses pushedAt to
--     decide whether the HEAD must be re-fetched, so unchanged repos never
--     trigger per-repo GitHub content calls.
--   * Repository.starredAt / unstarredAt - star lifecycle. Unstarring a
--     repository MUST NOT delete the user's knowledge assets: the row is kept
--     and unstarredAt is set; re-starring clears unstarredAt again.
--   * Analysis.sourceSha / contentHash and KnowledgeAsset.sourceSha /
--     contentHash - source HEAD SHA and content fingerprint the LLM run was
--     based on, so a later run can detect stale assets without re-reading files.
--
-- A partial unique index on SyncRun("userId") WHERE status = 'running' enforces
-- "one running sync per user" at the database level. Prisma's schema format
-- does not model partial indexes, so it is managed here, mirroring the
-- Analysis active-row index in migration 20261104190000.

BEGIN;

-- ── Repository sync provenance ──────────────────────────────────
ALTER TABLE "Repository" ADD COLUMN "headSha" TEXT;

ALTER TABLE "Repository" ADD COLUMN "syncHash" TEXT;

ALTER TABLE "Repository" ADD COLUMN "starredAt" TIMESTAMP(3);

ALTER TABLE "Repository" ADD COLUMN "unstarredAt" TIMESTAMP(3);

-- ── AI provenance for analysis results & extracted assets ───────
ALTER TABLE "Analysis" ADD COLUMN "sourceSha" TEXT;

ALTER TABLE "Analysis" ADD COLUMN "contentHash" TEXT;

ALTER TABLE "KnowledgeAsset" ADD COLUMN "sourceSha" TEXT;

ALTER TABLE "KnowledgeAsset" ADD COLUMN "contentHash" TEXT;

-- ── AutomationSettings ──────────────────────────────────────────
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoAnalyze" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "workerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- ── SyncRun ─────────────────────────────────────────────────────
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "unstarredCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "analysisQueuedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ─────────────────────────────────────────────────────
-- Scheduler scan: enabled + due automation rows, no disabled/non-due rows.
CREATE INDEX "AutomationSettings_enabled_nextSyncAt_idx" ON "AutomationSettings"("enabled", "nextSyncAt");

-- Per-user automation upsert key.
CREATE UNIQUE INDEX "AutomationSettings_userId_key" ON "AutomationSettings"("userId");

-- Per-user run audit trail plus recent-run lookup.
CREATE INDEX "SyncRun_userId_createdAt_idx" ON "SyncRun"("userId", "createdAt");

-- Running/failed reconciliation scan.
CREATE INDEX "SyncRun_status_idx" ON "SyncRun"("status");

-- ── Foreign keys ────────────────────────────────────────────────
ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── One running sync per user ───────────────────────────────────
-- The incremental sync service writes SyncRun rows with status 'running' while
-- it works. Two concurrent syncs for the same user collide on this partial
-- unique index (P2002) and the loser resolves to a friendly "already in
-- progress" error. Finished/failed rows (status != 'running') never occupy the
-- slot, so a later manual/scheduled run is not blocked by past history.
CREATE UNIQUE INDEX "SyncRun_userId_running_key"
  ON "SyncRun"("userId")
  WHERE "status" = 'running';

COMMIT;