CREATE TABLE "repository_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"execution_mode" "execution_mode" DEFAULT 'execute' NOT NULL,
	"base_branch" text NOT NULL,
	"model_id" text,
	"model_reasoning_effort" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_preferences" ADD CONSTRAINT "repository_preferences_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_preferences" ADD CONSTRAINT "repository_preferences_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_preferences_owner_repository_uq" ON "repository_preferences" USING btree ("owner_id","repository_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_id_idx" ON "messages" USING btree ("conversation_id","created_at","id");