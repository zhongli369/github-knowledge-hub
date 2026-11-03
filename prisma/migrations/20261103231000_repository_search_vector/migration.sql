-- PostgreSQL marks the generic array_to_string function as stable. For a text[]
-- input its result is deterministic, so this typed SQL wrapper is safe to mark
-- immutable and can be used in a generated column. It runs as the invoking user.
CREATE FUNCTION "public"."gkh_text_array_to_string"(text[], text)
RETURNS text
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS 'SELECT pg_catalog.array_to_string($1, $2)';

-- Replace the legacy nullable tsvector column. Its value is derived entirely
-- from name, description and topics, so PostgreSQL must maintain it automatically.
ALTER TABLE "Repository" DROP COLUMN "searchVector";

ALTER TABLE "Repository" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english'::regconfig,
      coalesce("name", '') || ' ' ||
      coalesce("description", '') || ' ' ||
      coalesce("public"."gkh_text_array_to_string"("topics", ' '), '')
    )
  ) STORED;

CREATE INDEX "Repository_searchVector_idx"
  ON "Repository" USING GIN ("searchVector");
