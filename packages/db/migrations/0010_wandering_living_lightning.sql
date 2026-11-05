CREATE TYPE "public"."runtime_desired_state" AS ENUM('sleeping', 'online');--> statement-breakpoint
CREATE TYPE "public"."runtime_instance_state" AS ENUM('sleeping', 'starting', 'online', 'stopping', 'fault');--> statement-breakpoint
CREATE TABLE "repository_instances" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"state" "runtime_instance_state" DEFAULT 'sleeping' NOT NULL,
	"desired_state" "runtime_desired_state" DEFAULT 'sleeping' NOT NULL,
	"reason_code" text DEFAULT 'never_started' NOT NULL,
	"reason_detail" text,
	"waiting_for" text,
	"queue_priority" integer DEFAULT 100 NOT NULL,
	"wake_requested_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"last_progress_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_stopped_at" timestamp with time zone,
	"last_health_at" timestamp with time zone,
	"pid" integer,
	"port" integer,
	"bridge_port" integer,
	"profile" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "bridge_callback_token_hash" text;--> statement-breakpoint
ALTER TABLE "repository_instances" ADD CONSTRAINT "repository_instances_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_instances_state_idx" ON "repository_instances" USING btree ("state");--> statement-breakpoint
CREATE INDEX "repository_instances_wake_idx" ON "repository_instances" USING btree ("wake_requested_at");