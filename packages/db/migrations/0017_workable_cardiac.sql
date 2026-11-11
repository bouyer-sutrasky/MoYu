CREATE TYPE "public"."cleanup_item_state" AS ENUM('planned', 'removed', 'skipped', 'failed', 'already_cleaned');--> statement-breakpoint
CREATE TYPE "public"."cleanup_run_mode" AS ENUM('preview', 'execute');--> statement-breakpoint
CREATE TYPE "public"."cleanup_run_status" AS ENUM('preview', 'running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "cleanup_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"conversation_id" uuid,
	"ticket_id" text NOT NULL,
	"profile" text,
	"directory" text,
	"state" "cleanup_item_state" DEFAULT 'planned' NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"size_bytes" bigint,
	"modified_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"mode" "cleanup_run_mode" NOT NULL,
	"status" "cleanup_run_status" DEFAULT 'preview' NOT NULL,
	"retention_days" integer DEFAULT 7 NOT NULL,
	"preview_of_run_id" uuid,
	"candidates" integer DEFAULT 0 NOT NULL,
	"eligible" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"already_cleaned" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"bytes_freed" bigint DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cleanup_items" ADD CONSTRAINT "cleanup_items_run_id_cleanup_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cleanup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_items" ADD CONSTRAINT "cleanup_items_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_runs" ADD CONSTRAINT "cleanup_runs_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_runs" ADD CONSTRAINT "cleanup_runs_preview_of_run_id_cleanup_runs_id_fk" FOREIGN KEY ("preview_of_run_id") REFERENCES "public"."cleanup_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cleanup_items_run_repository_ticket_uq" ON "cleanup_items" USING btree ("run_id","repository_id","ticket_id");--> statement-breakpoint
CREATE INDEX "cleanup_runs_owner_created_idx" ON "cleanup_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cleanup_runs_preview_uq" ON "cleanup_runs" USING btree ("preview_of_run_id") WHERE "cleanup_runs"."preview_of_run_id" is not null;