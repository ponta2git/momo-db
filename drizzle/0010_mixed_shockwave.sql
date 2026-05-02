CREATE TABLE "match_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_member_id" text NOT NULL,
	"status" text NOT NULL,
	"held_event_id" text,
	"match_no_in_event" integer,
	"game_title_id" text,
	"layout_family" text,
	"season_master_id" text,
	"owner_member_id" text,
	"map_master_id" text,
	"played_at" timestamp with time zone,
	"total_assets_image_id" text,
	"revenue_image_id" text,
	"incident_log_image_id" text,
	"total_assets_draft_id" text,
	"revenue_draft_id" text,
	"incident_log_draft_id" text,
	"source_images_retained_until" timestamp with time zone,
	"source_images_deleted_at" timestamp with time zone,
	"confirmed_match_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_drafts_status_check" CHECK ("match_drafts"."status" IN ('ocr_running','ocr_failed','draft_ready','needs_review','confirmed','cancelled')),
	CONSTRAINT "match_drafts_match_no_in_event_check" CHECK ("match_drafts"."match_no_in_event" IS NULL OR "match_drafts"."match_no_in_event" >= 1)
);
--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_held_event_id_held_events_id_fk" FOREIGN KEY ("held_event_id") REFERENCES "public"."held_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_season_master_id_season_masters_id_fk" FOREIGN KEY ("season_master_id") REFERENCES "public"."season_masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_map_master_id_map_masters_id_fk" FOREIGN KEY ("map_master_id") REFERENCES "public"."map_masters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_confirmed_match_id_matches_id_fk" FOREIGN KEY ("confirmed_match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_drafts_status_updated_at_idx" ON "match_drafts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "match_drafts_created_by_status_idx" ON "match_drafts" USING btree ("created_by_member_id","status");--> statement-breakpoint
CREATE INDEX "match_drafts_held_event_id_idx" ON "match_drafts" USING btree ("held_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_drafts_confirmed_match_id_unique" ON "match_drafts" USING btree ("confirmed_match_id");