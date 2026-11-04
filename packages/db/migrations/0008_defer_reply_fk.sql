-- Move the reply/parent composite FK to DEFERRABLE INITIALLY DEFERRED so a
-- transaction can move a whole reply graph (parents, children, duplicates)
-- between conversations without a transient cross-conversation row.
ALTER TABLE "messages" DROP CONSTRAINT "messages_reply_same_conversation_fk";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_same_conversation_fk" FOREIGN KEY ("reply_to_message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE SET NULL ("reply_to_message_id") ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;
