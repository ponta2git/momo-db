DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "discord_outbox"
    WHERE "kind" <> 'send_message'
  ) THEN
    RAISE EXCEPTION 'non-send discord_outbox rows require operator review before migration';
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "discord_outbox" DROP CONSTRAINT "discord_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "discord_outbox" ADD CONSTRAINT "discord_outbox_kind_check" CHECK ("discord_outbox"."kind" = 'send_message');
