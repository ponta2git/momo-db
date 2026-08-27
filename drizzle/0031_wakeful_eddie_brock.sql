ALTER TABLE "matches" ADD COLUMN "note_body" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "note_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "note_updated_by_account_id" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "note_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_note_updated_by_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("note_updated_by_account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_note_version_check" CHECK ("matches"."note_version" >= 0);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_note_shape_check" CHECK ((
        ("matches"."note_version" = 0 AND "matches"."note_body" IS NULL AND "matches"."note_updated_by_account_id" IS NULL AND "matches"."note_updated_at" IS NULL)
        OR
        ("matches"."note_version" > 0 AND "matches"."note_updated_by_account_id" IS NOT NULL AND "matches"."note_updated_at" IS NOT NULL)
      ));