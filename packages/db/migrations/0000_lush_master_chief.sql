CREATE TYPE "public"."artifact_type" AS ENUM('diff', 'check_report', 'pull_request', 'attachment', 'log', 'other');--> statement-breakpoint
CREATE TYPE "public"."auth_challenge_kind" AS ENUM('registration', 'authentication');--> statement-breakpoint
CREATE TYPE "public"."conversation_mode" AS ENUM('work', 'chat');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('pending', 'delivering', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."execution_mode" AS ENUM('execute', 'discuss');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."repository_status" AS ENUM('provisioning', 'active', 'sleeping', 'error');--> statement-breakpoint
CREATE TYPE "public"."runtime_lease_state" AS ENUM('active', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('pending_admission', 'discussing', 'queued', 'running', 'waiting_input', 'awaiting_review', 'stopping', 'stopped', 'blocked', 'failed', 'completed', 'closed_unmerged', 'not_accepted');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"conversation_id" uuid,
	"task_id" uuid,
	"type" "artifact_type" NOT NULL,
	"storage_key" text,
	"mime_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_size_bytes_nonnegative" CHECK ("artifacts"."size_bytes" is null or "artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"kind" "auth_challenge_kind" NOT NULL,
	"challenge" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"mode" "conversation_mode" DEFAULT 'work' NOT NULL,
	"execution_mode" "execution_mode" DEFAULT 'execute' NOT NULL,
	"base_branch" text NOT NULL,
	"base_commit" text,
	"model_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"state" "delivery_state" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_attempt_count_nonnegative" CHECK ("deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"type" text NOT NULL,
	"source" text DEFAULT 'internal' NOT NULL,
	"source_event_id" text,
	"repository_id" uuid,
	"conversation_id" uuid,
	"task_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"client_message_id" text,
	"body" text NOT NULL,
	"reply_to_message_id" uuid,
	"source" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"github_repository_id" bigint,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"status" "repository_status" DEFAULT 'provisioning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"holder_id" text NOT NULL,
	"fencing_token" bigserial NOT NULL,
	"state" "runtime_lease_state" DEFAULT 'active' NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"credential_id" uuid,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"upstream_ticket_id" text,
	"upstream_thread_id" text,
	"state" "task_state" DEFAULT 'pending_admission' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"base_branch" text NOT NULL,
	"base_commit" text,
	"model_id" text,
	"execution_mode" "execution_mode" DEFAULT 'execute' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_links_version_nonnegative" CHECK ("task_links"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_task_links_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_task_id_task_links_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_leases" ADD CONSTRAINT "runtime_leases_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_credential_id_passkey_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."passkey_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_task_idx" ON "artifacts" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "artifacts_conversation_idx" ON "artifacts" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_storage_key_uq" ON "artifacts" USING btree ("storage_key") WHERE "artifacts"."storage_key" is not null;--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_at_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "conversations_repository_idx" ON "conversations" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "conversations_owner_idx" ON "conversations" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credentials_credential_id_uq" ON "passkey_credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkey_credentials_owner_idx" ON "passkey_credentials" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_message_uq" ON "deliveries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "deliveries_state_next_attempt_idx" ON "deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_seq_uq" ON "events" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_event_uq" ON "events" USING btree ("source","source_event_id") WHERE "events"."source_event_id" is not null;--> statement-breakpoint
CREATE INDEX "events_repository_seq_idx" ON "events" USING btree ("repository_id","seq");--> statement-breakpoint
CREATE INDEX "events_conversation_seq_idx" ON "events" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_client_message_uq" ON "messages" USING btree ("conversation_id","client_message_id") WHERE "messages"."client_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_full_name_uq" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_github_id_uq" ON "repositories" USING btree ("github_repository_id") WHERE "repositories"."github_repository_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_leases_fencing_token_uq" ON "runtime_leases" USING btree ("fencing_token");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_leases_active_repository_uq" ON "runtime_leases" USING btree ("repository_id") WHERE "runtime_leases"."state" = 'active';--> statement-breakpoint
CREATE INDEX "runtime_leases_expires_at_idx" ON "runtime_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_owner_idx" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_links_conversation_uq" ON "task_links" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_links_repository_upstream_ticket_uq" ON "task_links" USING btree ("repository_id","upstream_ticket_id") WHERE "task_links"."upstream_ticket_id" is not null;--> statement-breakpoint
CREATE INDEX "task_links_state_idx" ON "task_links" USING btree ("state");