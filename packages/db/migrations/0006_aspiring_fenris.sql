CREATE TABLE "duplicate_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"ticket_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "duplicate_tickets" ADD CONSTRAINT "duplicate_tickets_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_tickets" ADD CONSTRAINT "duplicate_tickets_task_id_task_links_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_tickets_repository_ticket_uq" ON "duplicate_tickets" USING btree ("repository_id","ticket_id");--> statement-breakpoint
CREATE INDEX "duplicate_tickets_due_idx" ON "duplicate_tickets" USING btree ("state","next_attempt_at");