ALTER TABLE "task_links" ADD COLUMN "decision" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "pr_updated_at" timestamp with time zone;