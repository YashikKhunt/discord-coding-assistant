DROP INDEX "jobs_status_idx";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_status_created_at_idx" ON "jobs" USING btree ("status","created_at");