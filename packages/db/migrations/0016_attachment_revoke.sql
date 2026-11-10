-- Soft revocation for uploaded attachments: the bytes and the row stay, but a
-- revoked attachment is no longer downloadable or sendable.
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
