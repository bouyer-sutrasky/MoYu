CREATE TYPE "public"."bootstrap_code_purpose" AS ENUM('initial', 'recovery');--> statement-breakpoint
CREATE TABLE "bootstrap_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "bootstrap_code_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"token_hash" text,
	"owner_id" uuid,
	"request_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD COLUMN "context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "bootstrap_codes" ADD CONSTRAINT "bootstrap_codes_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_codes_code_hash_uq" ON "bootstrap_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_codes_token_hash_uq" ON "bootstrap_codes" USING btree ("token_hash") WHERE "bootstrap_codes"."token_hash" is not null;--> statement-breakpoint
CREATE INDEX "bootstrap_codes_expires_at_idx" ON "bootstrap_codes" USING btree ("expires_at");