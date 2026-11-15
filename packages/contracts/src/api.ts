import { z } from 'zod';

import { isoTimestampSchema } from './common';

export const apiErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'dependency_unavailable',
  'internal_error',
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const apiErrorResponseSchema = z.object({
  error: apiErrorSchema,
  requestId: z.string().min(1),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export function apiSuccessResponseSchema<T>(data: z.ZodType<T>) {
  return z.object({
    data,
    requestId: z.string().min(1),
  });
}

export interface ApiSuccessResponse<T> {
  data: T;
  requestId: string;
}

export function successResponse<T>(data: T, requestId: string): ApiSuccessResponse<T> {
  return { data, requestId };
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
  requestId: string,
): ApiErrorResponse {
  return { error: { code, message, retryable }, requestId };
}

/**
 * Health payload shared by the API process and the web shell. The shape stays
 * deliberately small: liveness must not depend on the database.
 */
export const healthDataSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('moyu-api'),
  version: z.string().min(1),
  uptimeSeconds: z.number().int().nonnegative(),
  timestamp: isoTimestampSchema,
});

export type HealthData = z.infer<typeof healthDataSchema>;

export const healthResponseSchema = apiSuccessResponseSchema(healthDataSchema);

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readinessDataSchema = z.object({
  status: z.literal('ok'),
  database: z.literal('ok'),
});

export type ReadinessData = z.infer<typeof readinessDataSchema>;

export const readinessResponseSchema = apiSuccessResponseSchema(readinessDataSchema);
