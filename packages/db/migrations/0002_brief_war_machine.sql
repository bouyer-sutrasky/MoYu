CREATE TABLE "runtime_cursors" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "model_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "upstream_trigger_id" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "handed_to_worker_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source_event_id" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "bridge_url" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "bridge_credential_ref" text;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "model_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "question_message_id" uuid;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "task_links" ADD COLUMN "last_event_seq" bigint;--> statement-breakpoint
ALTER TABLE "runtime_cursors" ADD CONSTRAINT "runtime_cursors_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_owner_client_request_uq" ON "conversations" USING btree ("owner_id","client_request_id") WHERE "conversations"."client_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_source_event_uq" ON "messages" USING btree ("conversation_id","source_event_id") WHERE "messages"."source_event_id" is not null;