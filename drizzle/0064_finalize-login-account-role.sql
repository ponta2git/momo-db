DROP INDEX "momo_login_accounts_is_admin_idx";--> statement-breakpoint
ALTER TABLE "momo_login_accounts" ALTER COLUMN "role" SET DEFAULT 'user';--> statement-breakpoint
ALTER TABLE "momo_login_accounts" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "momo_login_accounts" DROP COLUMN "is_admin";