CREATE TABLE "repository_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"actor_owner_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "check_commands" jsonb;--> statement-breakpoint
ALTER TABLE "repository_audit_events" ADD CONSTRAINT "repository_audit_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_audit_events" ADD CONSTRAINT "repository_audit_events_actor_owner_id_owners_id_fk" FOREIGN KEY ("actor_owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_audit_events_repository_idx" ON "repository_audit_events" USING btree ("repository_id","created_at");--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_check_commands_shape" CHECK ("repositories"."check_commands" is null or (jsonb_typeof("repositories"."check_commands") = 'array' and jsonb_array_length("repositories"."check_commands") between 1 and 8));