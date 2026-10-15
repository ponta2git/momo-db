CREATE TABLE "oauth_state_consumptions" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oauth_state_consumptions_expires_at_idx" ON "oauth_state_consumptions" USING btree ("expires_at");