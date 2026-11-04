BEGIN;

-- Repository identity is scoped to its owner. Different users may sync the
-- same GitHub repository without sharing Repository, Analysis, or asset rows.
DROP INDEX "Repository_githubId_key";
DROP INDEX "Repository_fullName_key";

CREATE UNIQUE INDEX "Repository_userId_githubId_key"
  ON "Repository"("userId", "githubId");
CREATE UNIQUE INDEX "Repository_userId_fullName_key"
  ON "Repository"("userId", "fullName");

-- Enqueue performs an ownership check before insert and handles P2002 by
-- returning the concurrent winner. This partial index closes the race between
-- its pre-check and insert without blocking a later retry after completion or
-- failure. Legacy duplicate active rows must be reviewed before deployment;
-- the migration deliberately fails rather than deleting or rewriting them.
CREATE UNIQUE INDEX "Analysis_active_repository_user_type_key"
  ON "Analysis"("repositoryId", "userId", "analysisType")
  WHERE "repositoryId" IS NOT NULL AND "status" IN ('pending', 'running');

COMMIT;
