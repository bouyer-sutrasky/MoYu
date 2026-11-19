ALTER TABLE "repositories" ADD COLUMN "deletion_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "deletion_detail" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "deletion_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "deletion_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "deletion_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_deletion_state_check" CHECK ("repositories"."deletion_state" in ('none', 'deleting', 'failed', 'removed'));