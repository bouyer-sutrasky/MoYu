-- Reverse 0008: restore the immediate reply/parent composite FK.
\set ON_ERROR_STOP on
\if :{?hash}
\else
  \set hash __MOYU_0008_HASH_MISSING__
\endif
BEGIN;
SET LOCAL moyu.rollback_hash = :'hash';
DO $$
DECLARE
  expected constant text := 'd8a838ea7e5fd093ed4769e5c8901211b2c0869e0ff266bdb86fc4007ee93056';
  supplied text := current_setting('moyu.rollback_hash', true);
  matching integer;
  latest text;
BEGIN
  IF supplied IS NULL OR supplied = '' OR supplied = '__MOYU_0008_HASH_MISSING__' THEN
    RAISE EXCEPTION '0008 rollback refused: pass -v hash=<sha256 of 0008_defer_reply_fk.sql>';
  END IF;
  IF supplied <> expected THEN RAISE EXCEPTION '0008 rollback refused: hash mismatch'; END IF;
  SELECT count(*) INTO matching FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF matching <> 1 THEN RAISE EXCEPTION '0008 rollback refused: expected one applied 0008 migration, found %', matching; END IF;
  SELECT hash INTO latest FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest <> expected THEN RAISE EXCEPTION '0008 rollback refused: 0008 is not the latest applied migration'; END IF;
END $$;
ALTER TABLE "messages" DROP CONSTRAINT "messages_reply_same_conversation_fk";
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_same_conversation_fk" FOREIGN KEY ("reply_to_message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE SET NULL ("reply_to_message_id") ON UPDATE no action;
DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'd8a838ea7e5fd093ed4769e5c8901211b2c0869e0ff266bdb86fc4007ee93056';
COMMIT;
