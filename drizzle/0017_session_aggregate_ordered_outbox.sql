ALTER TABLE "discord_outbox" DROP CONSTRAINT "discord_outbox_status_check";--> statement-breakpoint
DROP INDEX "uq_discord_outbox_dedupe_active";--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD COLUMN "aggregate_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD COLUMN "ordinal" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "responses" ADD COLUMN "source_interaction_id" numeric(20, 0);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD CONSTRAINT "discord_outbox_status_check" CHECK ("discord_outbox"."status" IN ('PENDING','IN_FLIGHT','DELIVERED','FAILED','CANCELLED'));--> statement-breakpoint

-- Stop without altering legacy business state when the old claim protocol is still visible.
-- An operator must inspect those rows before retrying the migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sessions"
    WHERE "status" = 'DECIDED'
      AND "reminder_sent_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'legacy DECIDED reminder claims require operator review before migration';
  END IF;
END
$$;--> statement-breakpoint

-- The former partial index allowed duplicate FAILED dedupe keys. Preserve all rows and abort
-- instead of choosing or rewriting an audit record implicitly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "discord_outbox"
    GROUP BY "dedupe_key"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate discord_outbox dedupe keys require operator review before migration';
  END IF;
END
$$;--> statement-breakpoint

-- Give every existing intent a stable per-Session order before adding the unique constraint.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "session_id"
      ORDER BY "created_at", "id"
    ) - 1 AS "aggregate_revision"
  FROM "discord_outbox"
)
UPDATE "discord_outbox" AS target
SET "aggregate_revision" = ranked."aggregate_revision",
    "ordinal" = 0
FROM ranked
WHERE target."id" = ranked."id";--> statement-breakpoint

-- Future Session mutations must allocate revisions after every migrated intent.
WITH next_revisions AS (
  SELECT
    "session_id",
    max("aggregate_revision") + 1 AS "next_revision"
  FROM "discord_outbox"
  GROUP BY "session_id"
)
UPDATE "sessions" AS target
SET "revision" = greatest(target."revision", next_revisions."next_revision")
FROM next_revisions
WHERE target."id" = next_revisions."session_id";--> statement-breakpoint

CREATE UNIQUE INDEX "uq_discord_outbox_session_order" ON "discord_outbox" USING btree ("session_id","aggregate_revision","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_discord_outbox_dedupe_active" ON "discord_outbox" USING btree ("dedupe_key");--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD CONSTRAINT "discord_outbox_aggregate_revision_check" CHECK ("discord_outbox"."aggregate_revision" >= 0);--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD CONSTRAINT "discord_outbox_ordinal_check" CHECK ("discord_outbox"."ordinal" >= 0);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revision_check" CHECK ("sessions"."revision" >= 0);
