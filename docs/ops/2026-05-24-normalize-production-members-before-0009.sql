-- One-time production data repair before running drizzle migration 0009_seed_members.sql.
--
-- Context:
-- - Production was originally extracted from summit with member IDs member-1..member-4.
-- - momo-result migrations 0009+ expect stable IDs member_ponta/member_akane_mami/member_otaka/member_eu.
-- - Do not edit existing drizzle migration files that may already be applied locally.
--
-- Safety:
-- - Runs only while drizzle migration count is exactly 7, matching production before 0007+.
-- - Updates only the four known Discord user IDs.
-- - Preserves existing responses and held_event_participants by rewriting their member_id FKs.
-- - May be re-run before 0009; it becomes a no-op after the first successful run.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  migration_count integer;
BEGIN
  SELECT count(*) INTO migration_count
  FROM drizzle.__drizzle_migrations;

  IF migration_count <> 7 THEN
    RAISE EXCEPTION 'Expected exactly 7 applied drizzle migrations before this repair, got %', migration_count;
  END IF;

  IF EXISTS (
    WITH fixed_members(id, user_id) AS (VALUES
      ('member_ponta', '523484457705930752'),
      ('member_akane_mami', '716205987073228902'),
      ('member_otaka', '711582748103540828'),
      ('member_eu', '711560406891757570')
    )
    SELECT 1
    FROM fixed_members
    LEFT JOIN members ON members.user_id = fixed_members.user_id
    WHERE members.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Expected all four known Discord user IDs to exist in members before repair';
  END IF;

  IF EXISTS (
    WITH fixed_members(id, user_id) AS (VALUES
      ('member_ponta', '523484457705930752'),
      ('member_akane_mami', '716205987073228902'),
      ('member_otaka', '711582748103540828'),
      ('member_eu', '711560406891757570')
    )
    SELECT 1
    FROM members
    JOIN fixed_members ON fixed_members.id = members.id
    WHERE members.user_id <> fixed_members.user_id
  ) THEN
    RAISE EXCEPTION 'A target fixed member ID already exists with a different Discord user ID';
  END IF;
END $$;

ALTER TABLE "responses" DROP CONSTRAINT IF EXISTS "responses_member_id_members_id_fk";
ALTER TABLE "held_event_participants" DROP CONSTRAINT IF EXISTS "held_event_participants_member_id_members_id_fk";

WITH fixed_members(id, user_id, display_name) AS (VALUES
  ('member_ponta', '523484457705930752', 'ぽんた'),
  ('member_akane_mami', '716205987073228902', 'あかねまみ'),
  ('member_otaka', '711582748103540828', 'おーたか'),
  ('member_eu', '711560406891757570', 'いーゆー')
),
current_members AS (
  SELECT members.id AS current_id, fixed_members.id AS fixed_id
  FROM members
  JOIN fixed_members ON fixed_members.user_id = members.user_id
  WHERE members.id <> fixed_members.id
)
UPDATE "responses"
SET "member_id" = current_members.fixed_id
FROM current_members
WHERE "responses"."member_id" = current_members.current_id;

WITH fixed_members(id, user_id, display_name) AS (VALUES
  ('member_ponta', '523484457705930752', 'ぽんた'),
  ('member_akane_mami', '716205987073228902', 'あかねまみ'),
  ('member_otaka', '711582748103540828', 'おーたか'),
  ('member_eu', '711560406891757570', 'いーゆー')
),
current_members AS (
  SELECT members.id AS current_id, fixed_members.id AS fixed_id
  FROM members
  JOIN fixed_members ON fixed_members.user_id = members.user_id
  WHERE members.id <> fixed_members.id
)
UPDATE "held_event_participants"
SET "member_id" = current_members.fixed_id
FROM current_members
WHERE "held_event_participants"."member_id" = current_members.current_id;

WITH fixed_members(id, user_id, display_name) AS (VALUES
  ('member_ponta', '523484457705930752', 'ぽんた'),
  ('member_akane_mami', '716205987073228902', 'あかねまみ'),
  ('member_otaka', '711582748103540828', 'おーたか'),
  ('member_eu', '711560406891757570', 'いーゆー')
)
UPDATE "members"
SET
  "id" = fixed_members.id,
  "display_name" = fixed_members.display_name
FROM fixed_members
WHERE "members"."user_id" = fixed_members.user_id
  AND "members"."id" <> fixed_members.id;

ALTER TABLE "responses"
  ADD CONSTRAINT "responses_member_id_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."members"("id")
  ON DELETE no action ON UPDATE no action NOT VALID;

ALTER TABLE "held_event_participants"
  ADD CONSTRAINT "held_event_participants_member_id_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."members"("id")
  ON DELETE no action ON UPDATE no action NOT VALID;

ALTER TABLE "responses" VALIDATE CONSTRAINT "responses_member_id_members_id_fk";
ALTER TABLE "held_event_participants" VALIDATE CONSTRAINT "held_event_participants_member_id_members_id_fk";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM members
    WHERE id IN ('member-1', 'member-2', 'member-3', 'member-4')
  ) THEN
    RAISE EXCEPTION 'Legacy member IDs remain in members after repair';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM responses
    WHERE member_id IN ('member-1', 'member-2', 'member-3', 'member-4')
  ) THEN
    RAISE EXCEPTION 'Legacy member IDs remain in responses after repair';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM held_event_participants
    WHERE member_id IN ('member-1', 'member-2', 'member-3', 'member-4')
  ) THEN
    RAISE EXCEPTION 'Legacy member IDs remain in held_event_participants after repair';
  END IF;
END $$;

COMMIT;
