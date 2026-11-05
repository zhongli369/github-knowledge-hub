BEGIN;

-- Existing collections remain custom knowledge-asset collections. Functional
-- categories use a stable per-user slug and a separate repository relation.
ALTER TABLE "Collection"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'custom',
  ADD COLUMN "slug" TEXT;

CREATE TABLE "CollectionRepository" (
  "id" TEXT NOT NULL,
  "collectionId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'auto',
  "excluded" BOOLEAN NOT NULL DEFAULT false,
  "confidence" DOUBLE PRECISION,
  "reason" TEXT,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CollectionRepository_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RepositoryClassification" (
  "repositoryId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "classifierVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "categorySlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "error" TEXT,
  "classifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RepositoryClassification_pkey" PRIMARY KEY ("repositoryId")
);

CREATE UNIQUE INDEX "Collection_userId_slug_key"
  ON "Collection"("userId", "slug");
CREATE INDEX "Collection_userId_kind_idx"
  ON "Collection"("userId", "kind");
CREATE UNIQUE INDEX "CollectionRepository_collectionId_repositoryId_key"
  ON "CollectionRepository"("collectionId", "repositoryId");
CREATE INDEX "CollectionRepository_collectionId_excluded_idx"
  ON "CollectionRepository"("collectionId", "excluded");
CREATE INDEX "CollectionRepository_repositoryId_excluded_idx"
  ON "CollectionRepository"("repositoryId", "excluded");
CREATE INDEX "RepositoryClassification_userId_status_idx"
  ON "RepositoryClassification"("userId", "status");

ALTER TABLE "CollectionRepository"
  ADD CONSTRAINT "CollectionRepository_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "Collection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionRepository"
  ADD CONSTRAINT "CollectionRepository_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryClassification"
  ADD CONSTRAINT "RepositoryClassification_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryClassification"
  ADD CONSTRAINT "RepositoryClassification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
