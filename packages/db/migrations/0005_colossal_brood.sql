CREATE TYPE "public"."conversation_source" AS ENUM('web', 'github');--> statement-breakpoint
CREATE TYPE "public"."task_operation_kind" AS ENUM('start', 'pause', 'resume', 'retry');--> statement-breakpoint
CREATE TYPE "public"."task_operation_state" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "task_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" "task_operation_kind" NOT NULL,
	"state" "task_operation_state" DEFAULT 'queued' NOT NULL,
	"client_command_id" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"bridge_operation_id" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_operations_attempt_count_nonnegative" CHECK ("task_operations"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "source" "conversation_source" DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "plan_revision" integer;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "plan_revision" integer;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "stop_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "stop_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "runtime_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "task_operations" ADD CONSTRAINT "task_operations_task_id_task_links_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_operations" ADD CONSTRAINT "task_operations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_operations_task_client_command_uq" ON "task_operations" USING btree ("task_id","client_command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_operations_active_task_uq" ON "task_operations" USING btree ("task_id") WHERE "task_operations"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "task_operations_state_next_attempt_idx" ON "task_operations" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "task_operations_repository_idx" ON "task_operations" USING btree ("repository_id","state");--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_runtime_lease_id_runtime_leases_id_fk" FOREIGN KEY ("runtime_lease_id") REFERENCES "public"."runtime_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_repository_external_uq" ON "conversations" USING btree ("repository_id","source","external_key") WHERE "conversations"."external_key" is not null;