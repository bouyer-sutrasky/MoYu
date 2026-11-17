ALTER TABLE "repository_instances" ADD COLUMN "git_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD COLUMN "git_phase" text;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD COLUMN "git_progress" integer;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD COLUMN "git_detail" text;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD COLUMN "git_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD COLUMN "git_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD COLUMN "git_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD COLUMN "git_head" text;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD CONSTRAINT "repository_instances_git_state_check" CHECK ("repository_instances"."git_state" in ('none','preparing','ready','failed'));--> statement-breakpoint
ALTER TABLE "repository_instances" ADD CONSTRAINT "repository_instances_git_progress_check" CHECK ("repository_instances"."git_progress" is null or "repository_instances"."git_progress" between 0 and 100);--> statement-breakpoint
ALTER TABLE "repository_instances" ADD CONSTRAINT "repository_instances_git_phase_check" CHECK ("repository_instances"."git_phase" is null or "repository_instances"."git_phase" in ('connecting','receiving','resolving','finalizing','verifying','ready'));--> statement-breakpoint
ALTER TABLE "repository_instances" ADD CONSTRAINT "repository_instances_git_attempts_check" CHECK ("repository_instances"."git_attempts" >= 0);