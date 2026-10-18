-- Number existing entities by the exact UTF-8 legacy ID, independently per table.
-- The normal migrator holds this lock through identity creation and sequence alignment.
LOCK TABLE "public"."held_events", "public"."matches" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."held_events" WHERE "public_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "public"."matches" WHERE "public_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Public identifier backfill requires unassigned public_id columns';
  END IF;
END
$$;
--> statement-breakpoint
WITH numbered AS (
  SELECT "id", row_number() OVER (ORDER BY "id" COLLATE "C") AS "public_id"
  FROM "public"."held_events"
)
UPDATE "public"."held_events" AS entity
SET "public_id" = numbered."public_id"
FROM numbered
WHERE entity."id" = numbered."id";
--> statement-breakpoint
WITH numbered AS (
  SELECT "id", row_number() OVER (ORDER BY "id" COLLATE "C") AS "public_id"
  FROM "public"."matches"
)
UPDATE "public"."matches" AS entity
SET "public_id" = numbered."public_id"
FROM numbered
WHERE entity."id" = numbered."id";
