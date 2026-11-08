ALTER TABLE "artifacts" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_message_idx" ON "artifacts" USING btree ("message_id");