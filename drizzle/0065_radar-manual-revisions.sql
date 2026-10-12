CREATE TABLE "series_radar_revisions" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"game_title_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"before_basis_id" text,
	"after_basis_id" text NOT NULL,
	"change_kind" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_by_display_name" text,
	"saved_by" text,
	"saved_by_display_name" text,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "series_radar_revision_kind_check" CHECK ("series_radar_revisions"."change_kind" IN ('generated','manual','restore'))
);
--> statement-breakpoint
ALTER TABLE "series_radar_operations" DROP CONSTRAINT "series_radar_operations_kind_check";--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD COLUMN "origin_kind" text DEFAULT 'generated' NOT NULL;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD COLUMN "manual_input" jsonb;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD COLUMN "source_basis_id" text;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD COLUMN "source_candidate_id" text;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD COLUMN "saved_by" text;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD COLUMN "saved_by_display_name" text;--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD COLUMN "requested_by_display_name" text;--> statement-breakpoint
ALTER TABLE "series_radar_revisions" ADD CONSTRAINT "series_radar_revisions_game_title_id_game_titles_id_fk" FOREIGN KEY ("game_title_id") REFERENCES "public"."game_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_revisions" ADD CONSTRAINT "series_radar_revision_operation_fk" FOREIGN KEY ("operation_id","game_title_id") REFERENCES "public"."series_radar_operations"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_revisions" ADD CONSTRAINT "series_radar_revision_candidate_fk" FOREIGN KEY ("candidate_id","game_title_id") REFERENCES "public"."series_radar_candidates"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_revisions" ADD CONSTRAINT "series_radar_revision_before_fk" FOREIGN KEY ("before_basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_revisions" ADD CONSTRAINT "series_radar_revision_after_fk" FOREIGN KEY ("after_basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "series_radar_revisions_created_idx" ON "series_radar_revisions" USING btree ("published_at","operation_id");--> statement-breakpoint
CREATE INDEX "series_radar_revisions_title_created_idx" ON "series_radar_revisions" USING btree ("game_title_id","published_at","operation_id");--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidate_source_basis_fk" FOREIGN KEY ("source_basis_id","game_title_id") REFERENCES "public"."series_radar_bases"("id","game_title_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidate_origin_check" CHECK ("series_radar_candidates"."origin_kind" IN ('generated','manual','restore'));--> statement-breakpoint
ALTER TABLE "series_radar_candidates" ADD CONSTRAINT "series_radar_candidate_manual_check" CHECK (("series_radar_candidates"."origin_kind" = 'manual') = ("series_radar_candidates"."manual_input" IS NOT NULL) AND ("series_radar_candidates"."origin_kind" <> 'manual' OR ("series_radar_candidates"."source_basis_id" IS NOT NULL AND "series_radar_candidates"."saved_by" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "series_radar_operations" ADD CONSTRAINT "series_radar_operations_kind_check" CHECK ("series_radar_operations"."kind" IN ('candidate','manual','preview','apply','withdraw','restore','acknowledge','retry'));