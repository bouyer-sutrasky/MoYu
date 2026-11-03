import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

/**
 * Public bootstrap state. It deliberately contains no credential identifiers;
 * it only tells the client whether first registration is still open or whether
 * a server-generated recovery code is required.
 */
export const authStateDataSchema = z.object({
  initialized: z.boolean(),
  activeCredentialCount: z.number().int().nonnegative(),
  setupOpen: z.boolean(),
  recoveryOpen: z.boolean(),
  rpId: z.string().min(1),
  origin: z.string().url(),
});

export type AuthStateData = z.infer<typeof authStateDataSchema>;

export const authStateResponseSchema = z.object({
  data: authStateDataSchema,
  requestId: z.string().min(1),
});

export const passkeyCredentialSummarySchema = z.object({
  id: uuidSchema,
  label: z.string().nullable(),
  deviceType: z.string().nullable(),
  backedUp: z.boolean(),
  transports: z.array(z.string()),
  createdAt: isoTimestampSchema,
  lastUsedAt: isoTimestampSchema.nullable(),
});

export type PasskeyCredentialSummary = z.infer<typeof passkeyCredentialSummarySchema>;

export const sessionSummarySchema = z.object({
  id: uuidSchema,
  userAgent: z.string().nullable(),
  createdAt: isoTimestampSchema,
  lastUsedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  current: z.boolean(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const authMeDataSchema = z.object({
  owner: z.object({
    id: uuidSchema,
    displayName: z.string().min(1),
  }),
  session: sessionSummarySchema,
  credentials: z.array(passkeyCredentialSummarySchema),
});

export type AuthMeData = z.infer<typeof authMeDataSchema>;

export const authMeResponseSchema = z.object({
  data: authMeDataSchema,
  requestId: z.string().min(1),
});

export const bootstrapExchangeInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9 -]+$/, { message: 'must contain only letters, digits and separators' }),
});

export type BootstrapExchangeInput = z.infer<typeof bootstrapExchangeInputSchema>;

export const bootstrapExchangeDataSchema = z.object({
  purpose: z.enum(['initial', 'recovery']),
  expiresAt: isoTimestampSchema,
  registrationExpiresAt: isoTimestampSchema,
});

export type BootstrapExchangeData = z.infer<typeof bootstrapExchangeDataSchema>;

/**
 * The WebAuthn options are produced and consumed by @simplewebauthn; the shared
 * contract only fixes the ceremony envelope so both ends exchange one JSON
 * object without inventing a second options shape.
 */
export const ceremonyOptionsSchema = z.object({
  ceremonyId: uuidSchema,
  optionsJSON: z.record(z.string(), z.unknown()),
});

export type CeremonyOptions = z.infer<typeof ceremonyOptionsSchema>;

export const registrationOptionsInputSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
});

export type RegistrationOptionsInput = z.infer<typeof registrationOptionsInputSchema>;

export const registrationVerifyInputSchema = z.object({
  ceremonyId: uuidSchema,
  response: z.record(z.string(), z.unknown()),
});

export type RegistrationVerifyInput = z.infer<typeof registrationVerifyInputSchema>;

export const registrationVerifyDataSchema = z.object({
  credential: passkeyCredentialSummarySchema,
  initialized: z.literal(true),
});

export type RegistrationVerifyData = z.infer<typeof registrationVerifyDataSchema>;

export const loginVerifyInputSchema = registrationVerifyInputSchema;

export type LoginVerifyInput = z.infer<typeof loginVerifyInputSchema>;

export const loginVerifyDataSchema = z.object({
  me: authMeDataSchema,
  expiresAt: isoTimestampSchema,
});

export type LoginVerifyData = z.infer<typeof loginVerifyDataSchema>;

export const revokeSessionDataSchema = z.object({
  revoked: z.literal(true),
});

export const credentialListDataSchema = z.object({
  credentials: z.array(passkeyCredentialSummarySchema),
});

export const sessionListDataSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});

export const logoutDataSchema = z.object({
  revoked: z.literal(true),
});
