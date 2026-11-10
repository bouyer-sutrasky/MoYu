import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

/**
 * A message attachment the owner uploaded before sending. The bytes live in
 * protected storage; the browser only ever receives this metadata plus a
 * download URL served by `GET /api/v1/attachments/:id`.
 */
export const attachmentKindSchema = z.enum(['image', 'text', 'binary']);

export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

export const attachmentSummarySchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  taskId: uuidSchema.nullable(),
  /** The message it was sent with; null while it is still an unsent draft upload. */
  messageId: uuidSchema.nullable(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  kind: attachmentKindSchema,
  /** Set when the owner revoked the attachment: the row and bytes remain, but download and sending stop. */
  revokedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  downloadUrl: z.string().min(1),
});

export type AttachmentSummary = z.infer<typeof attachmentSummarySchema>;

export const attachmentUploadDataSchema = z.object({
  attachment: attachmentSummarySchema,
});

/**
 * The revoke response has the same shape as the upload response; both semantic
 * names stay exported so callers and docs keep reading clearly.
 */
export const attachmentRevokeDataSchema = attachmentUploadDataSchema;

export type AttachmentRevokeData = z.infer<typeof attachmentRevokeDataSchema>;

export type AttachmentUploadData = z.infer<typeof attachmentUploadDataSchema>;

export const attachmentListDataSchema = z.object({
  attachments: z.array(attachmentSummarySchema),
});

export type AttachmentListData = z.infer<typeof attachmentListDataSchema>;

/** Upload limits the API enforces; the browser shows them before uploading. */
export const attachmentLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFilesPerMessage: 20,
  maxTotalBytesPerMessage: 25 * 1024 * 1024,
  maxFilenameLength: 120,
} as const;

/**
 * Types the owner may attach. Images and text are what a task usually needs;
 * anything else is stored and offered as a download, never rendered inline.
 */
export const ATTACHMENT_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const ATTACHMENT_TEXT_EXTENSIONS = [
  '.txt',
  '.log',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.sql',
  '.toml',
  '.ini',
  '.conf',
  '.sh',
  '.py',
  '.go',
  '.rs',
  '.java',
] as const;

export const ATTACHMENT_TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/x-ndjson',
  'application/yaml',
  'text/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-sh',
  'application/javascript',
  'text/javascript',
  'application/typescript',
  'text/typescript',
  'text/css',
  'text/html',
  'application/xml',
  'text/xml',
  'image/svg+xml',
] as const;

/** MIME types that are accepted for an upload; anything else is refused with 422. */
export const ATTACHMENT_ALLOWED_TYPES: readonly string[] = [
  ...ATTACHMENT_IMAGE_TYPES,
  ...ATTACHMENT_TEXT_TYPES,
];

export function attachmentKindFor(mimeType: string): AttachmentKind {
  if ((ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mimeType)) return 'image';
  if (
    mimeType.startsWith('text/') ||
    (ATTACHMENT_TEXT_TYPES as readonly string[]).includes(mimeType)
  ) {
    return 'text';
  }
  return 'binary';
}

/** A safe extension-based fallback for clients that send no usable content type. */
export function attachmentMimeFromFilename(filename: string): string | null {
  const lower = filename.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.'));
  if (!extension) return null;
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.json') return 'application/json';
  if (extension === '.md') return 'text/markdown';
  if ((ATTACHMENT_TEXT_EXTENSIONS as readonly string[]).includes(extension)) return 'text/plain';
  return null;
}
