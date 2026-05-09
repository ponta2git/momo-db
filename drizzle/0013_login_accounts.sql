CREATE TABLE "momo_login_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"discord_user_id" text NOT NULL,
	"display_name" varchar(64) NOT NULL,
	"player_member_id" text,
	"login_enabled" boolean DEFAULT true NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "momo_login_accounts_discord_user_id_unique" UNIQUE("discord_user_id")
);
--> statement-breakpoint
ALTER TABLE "momo_login_accounts" ADD CONSTRAINT "momo_login_accounts_player_member_id_members_id_fk" FOREIGN KEY ("player_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "momo_login_accounts_player_member_id_idx" ON "momo_login_accounts" USING btree ("player_member_id");--> statement-breakpoint
CREATE INDEX "momo_login_accounts_login_enabled_idx" ON "momo_login_accounts" USING btree ("login_enabled");--> statement-breakpoint
CREATE INDEX "momo_login_accounts_is_admin_idx" ON "momo_login_accounts" USING btree ("is_admin");--> statement-breakpoint
INSERT INTO "momo_login_accounts" ("id", "discord_user_id", "display_name", "player_member_id", "login_enabled", "is_admin")
SELECT
  CASE "id"
    WHEN 'member_ponta' THEN 'account_ponta'
    WHEN 'member_akane_mami' THEN 'account_akane_mami'
    WHEN 'member_otaka' THEN 'account_otaka'
    WHEN 'member_eu' THEN 'account_eu'
    ELSE 'account_' || "id"
  END,
  "user_id",
  "display_name",
  "id",
  true,
  "id" = 'member_ponta'
FROM "members"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "app_sessions" ADD COLUMN "account_id" text;--> statement-breakpoint
UPDATE "app_sessions"
SET "account_id" = "momo_login_accounts"."id"
FROM "momo_login_accounts"
WHERE "app_sessions"."member_id" = "momo_login_accounts"."player_member_id";--> statement-breakpoint
DELETE FROM "app_sessions" WHERE "account_id" IS NULL;--> statement-breakpoint
ALTER TABLE "app_sessions" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app_sessions" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_sessions" ADD CONSTRAINT "app_sessions_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_sessions_account_id_idx" ON "app_sessions" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "match_drafts" ADD COLUMN "created_by_account_id" text;--> statement-breakpoint
UPDATE "match_drafts"
SET "created_by_account_id" = "momo_login_accounts"."id"
FROM "momo_login_accounts"
WHERE "match_drafts"."created_by_member_id" = "momo_login_accounts"."player_member_id";--> statement-breakpoint
ALTER TABLE "match_drafts" ALTER COLUMN "created_by_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "match_drafts" ALTER COLUMN "created_by_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "match_drafts" ADD CONSTRAINT "match_drafts_created_by_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_drafts_created_by_account_status_idx" ON "match_drafts" USING btree ("created_by_account_id","status");--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "created_by_account_id" text;--> statement-breakpoint
UPDATE "matches"
SET "created_by_account_id" = "momo_login_accounts"."id"
FROM "momo_login_accounts"
WHERE "matches"."created_by_member_id" = "momo_login_accounts"."player_member_id";--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "created_by_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "created_by_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_created_by_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matches_created_by_account_id_idx" ON "matches" USING btree ("created_by_account_id");--> statement-breakpoint
DELETE FROM "idempotency_keys";--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_key_member_id_endpoint_pk";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "account_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_account_id_momo_login_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."momo_login_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("key","account_id","endpoint");
