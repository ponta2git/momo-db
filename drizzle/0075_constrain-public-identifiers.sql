ALTER TABLE "held_events" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "public_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "held_events" ADD CONSTRAINT "held_events_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_public_id_unique" UNIQUE("public_id");