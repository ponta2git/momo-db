CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"member_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"response_status" integer NOT NULL,
	"response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_body" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_key_member_id_endpoint_pk" PRIMARY KEY("key","member_id","endpoint")
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");