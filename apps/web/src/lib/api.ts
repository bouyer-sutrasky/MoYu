import {
  apiSuccessResponseSchema,
  authMeDataSchema,
  authStateDataSchema,
  bootstrapExchangeDataSchema,
  ceremonyOptionsSchema,
  credentialListDataSchema,
  loginVerifyDataSchema,
  registrationVerifyDataSchema,
  repositoryListDataSchema,
  revokeSessionDataSchema,
  sessionListDataSchema,
  type AuthMeData,
  type AuthStateData,
  type BootstrapExchangeData,
  type CeremonyOptions,
  type PasskeyCredentialSummary,
  type RepositorySummary,
  type SessionSummary,
} from '@moyu/contracts';
import type { z } from 'zod';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const envelope = payload as {
      error?: { code?: string; message?: string; retryable?: boolean };
    } | null;
    throw new ApiClientError(
      response.status,
      envelope?.error?.code ?? 'internal_error',
      envelope?.error?.message ?? `Request failed with HTTP ${response.status}`,
      envelope?.error?.retryable ?? false,
    );
  }

  const parsed = apiSuccessResponseSchema(schema).safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError(502, 'invalid_response', '服务端响应不符合共享契约');
  }
  return parsed.data.data as T;
}

export interface VerifyRegistrationResult {
  credential: PasskeyCredentialSummary;
  initialized: true;
}

export interface VerifyLoginResult {
  me: AuthMeData;
  expiresAt: string;
}

export const api = {
  authState(): Promise<AuthStateData> {
    return request('/api/v1/auth/state', authStateDataSchema);
  },
  me(): Promise<AuthMeData> {
    return request('/api/v1/auth/me', authMeDataSchema);
  },
  exchangeBootstrapCode(code: string): Promise<BootstrapExchangeData> {
    return request('/api/v1/auth/bootstrap/exchange', bootstrapExchangeDataSchema, {
      method: 'POST',
      body: { code },
    });
  },
  registrationOptions(label?: string): Promise<CeremonyOptions> {
    return request('/api/v1/auth/registration/options', ceremonyOptionsSchema, {
      method: 'POST',
      body: label ? { label } : {},
    });
  },
  verifyRegistration(
    ceremonyId: string,
    response: Record<string, unknown>,
  ): Promise<VerifyRegistrationResult> {
    return request('/api/v1/auth/registration/verify', registrationVerifyDataSchema, {
      method: 'POST',
      body: { ceremonyId, response },
    });
  },
  loginOptions(): Promise<CeremonyOptions> {
    return request('/api/v1/auth/login/options', ceremonyOptionsSchema, {
      method: 'POST',
      body: {},
    });
  },
  verifyLogin(ceremonyId: string, response: Record<string, unknown>): Promise<VerifyLoginResult> {
    return request('/api/v1/auth/login/verify', loginVerifyDataSchema, {
      method: 'POST',
      body: { ceremonyId, response },
    });
  },
  logout(): Promise<{ revoked: true }> {
    return request('/api/v1/auth/logout', revokeSessionDataSchema, { method: 'POST' });
  },
  sessions(): Promise<{ sessions: SessionSummary[] }> {
    return request('/api/v1/auth/sessions', sessionListDataSchema);
  },
  revokeSession(id: string): Promise<{ revoked: true }> {
    return request(`/api/v1/auth/sessions/${id}`, revokeSessionDataSchema, {
      method: 'DELETE',
    });
  },
  credentials(): Promise<{ credentials: PasskeyCredentialSummary[] }> {
    return request('/api/v1/auth/credentials', credentialListDataSchema);
  },
  revokeCredential(id: string): Promise<{ revoked: true }> {
    return request(`/api/v1/auth/credentials/${id}`, revokeSessionDataSchema, {
      method: 'DELETE',
    });
  },
  repositories(): Promise<{ repositories: RepositorySummary[] }> {
    return request('/api/v1/repositories', repositoryListDataSchema);
  },
};
