ALTER TABLE "series_analysis_queue_outbox" DROP CONSTRAINT "series_analysis_queue_outbox_status_check";--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" ADD COLUMN "redis_message_id" text;--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" ADD CONSTRAINT "series_analysis_queue_outbox_claim_shape_check" CHECK (("series_analysis_queue_outbox"."status" = 'in_flight') = ("series_analysis_queue_outbox"."claim_expires_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" ADD CONSTRAINT "series_analysis_queue_outbox_delivery_shape_check" CHECK (("series_analysis_queue_outbox"."status" = 'delivered') = ("series_analysis_queue_outbox"."delivered_at" IS NOT NULL AND "series_analysis_queue_outbox"."redis_message_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "series_analysis_queue_outbox" ADD CONSTRAINT "series_analysis_queue_outbox_status_check" CHECK ("series_analysis_queue_outbox"."status" IN ('pending','in_flight','delivered','failed'));
