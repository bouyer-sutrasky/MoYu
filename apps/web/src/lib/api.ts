import {
  apiSuccessResponseSchema,
  attachmentUploadDataSchema,
  authMeDataSchema,
  authStateDataSchema,
  bootstrapExchangeDataSchema,
  ceremonyOptionsSchema,
  conversationDetailDataSchema,
  conversationListDataSchema,
  createMessageDataSchema,
  credentialListDataSchema,
  loginVerifyDataSchema,
  messageDetailDataSchema,
  messageListDataSchema,
  modelListDataSchema,
  registrationVerifyDataSchema,
  repositoryActionDataSchema,
  repositoryBranchListDataSchema,
  repositoryListDataSchema,
  repositoryRuntimeDataSchema,
  githubRepositoryListDataSchema,
  repositoryPreferencesDataSchema,
  revokeSessionDataSchema,
  sessionListDataSchema,
  taskCommandDataSchema,
  taskReviewDataSchema,
  type AttachmentUploadData,
  type AuthMeData,
  type AuthStateData,
  type BootstrapExchangeData,
  type CeremonyOptions,
  type ConversationDetailData,
  type ConversationListData,
  type CreateConversationInput,
  type CreateMessageData,
  type CreateMessageInput,
  type MessageDetailData,
  type MessageListData,
  type ModelListData,
  type PasskeyCredentialSummary,
  type GithubRepositoryListData,
  type RepositoryActionData,
  type RepositoryBranchListData,
  type RepositoryPreferencesData,
  type RepositoryRuntimeData,
  type RepositoryPreferencesInput,
  type RepositorySummary,
  type SessionSummary,
  type StartTaskInput,
  type TaskCommandData,
  type TaskCommandInput,
  type TaskReviewData,
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
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
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

/**
 * Multipart upload. The shared JSON request helper cannot carry a file, so this
 * path repeats the envelope handling and keeps credentials same-origin.
 */
async function uploadRequest<T>(path: string, file: File, schema: z.ZodType<T>): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    body: form,
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
      envelope?.error?.message ?? `Upload failed with HTTP ${response.status}`,
      envelope?.error?.retryable ?? false,
    );
  }
  const parsed = apiSuccessResponseSchema(schema).safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError(502, 'invalid_response', '服务端响应不符合共享契约');
  }
  return parsed.data.data as T;
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
  githubRepositories(q?: string): Promise<GithubRepositoryListData> {
    const query = q ? `?q=${encodeURIComponent(q)}` : '';
    return request(`/api/v1/github/repositories${query}`, githubRepositoryListDataSchema);
  },
  addRepository(
    fullName: string,
  ): Promise<{ repositoryId: string; runtime: RepositoryRuntimeData['runtime'] }> {
    return request('/api/v1/repositories', repositoryRuntimeDataSchema, {
      method: 'POST',
      body: { fullName },
    });
  },
  repositoryRuntime(repositoryId: string): Promise<RepositoryRuntimeData> {
    return request(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/runtime`,
      repositoryRuntimeDataSchema,
    );
  },
  wakeRepository(repositoryId: string): Promise<RepositoryActionData> {
    return request(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/wake`,
      repositoryActionDataSchema,
      { method: 'POST' },
    );
  },
  sleepRepository(repositoryId: string): Promise<RepositoryActionData> {
    return request(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/sleep`,
      repositoryActionDataSchema,
      { method: 'POST' },
    );
  },
  conversations(
    repositoryId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<ConversationListData> {
    const query = new URLSearchParams({ repositoryId });
    if (options.limit) {
      query.set('limit', String(options.limit));
    }
    if (options.cursor) {
      query.set('cursor', options.cursor);
    }
    return request(`/api/v1/conversations?${query.toString()}`, conversationListDataSchema);
  },
  createConversation(input: CreateConversationInput): Promise<ConversationDetailData> {
    return request('/api/v1/conversations', conversationDetailDataSchema, {
      method: 'POST',
      body: input,
    });
  },
  conversation(id: string): Promise<ConversationDetailData> {
    return request(`/api/v1/conversations/${encodeURIComponent(id)}`, conversationDetailDataSchema);
  },
  messages(
    id: string,
    options: { before?: string; after?: string; limit?: number } = {},
  ): Promise<MessageListData> {
    const query = new URLSearchParams();
    if (options.before) {
      query.set('before', options.before);
    }
    if (options.after) {
      query.set('after', options.after);
    }
    if (options.limit) {
      query.set('limit', String(options.limit));
    }
    const queryString = query.toString();
    const suffix = queryString.length > 0 ? `?${queryString}` : '';
    return request(
      `/api/v1/conversations/${encodeURIComponent(id)}/messages${suffix}`,
      messageListDataSchema,
    );
  },
  message(id: string, messageId: string): Promise<MessageDetailData> {
    return request(
      `/api/v1/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
      messageDetailDataSchema,
    );
  },
  sendMessage(id: string, input: CreateMessageInput): Promise<CreateMessageData> {
    return request(
      `/api/v1/conversations/${encodeURIComponent(id)}/messages`,
      createMessageDataSchema,
      { method: 'POST', body: input },
    );
  },
  uploadAttachment(conversationId: string, file: File): Promise<AttachmentUploadData> {
    return uploadRequest(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/attachments`,
      file,
      attachmentUploadDataSchema,
    );
  },
  taskReview(taskId: string): Promise<TaskReviewData> {
    return request(`/api/v1/tasks/${encodeURIComponent(taskId)}/review`, taskReviewDataSchema);
  },
  refreshTaskReview(taskId: string): Promise<TaskReviewData> {
    return request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/review/changes`,
      taskReviewDataSchema,
      { method: 'POST', body: {} },
    );
  },
  runTaskChecks(taskId: string): Promise<TaskReviewData> {
    return request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/review/checks`,
      taskReviewDataSchema,
      { method: 'POST', body: {} },
    );
  },
  taskCommand(
    taskId: string,
    action: 'start' | 'stop' | 'resume' | 'retry',
    input: TaskCommandInput & { planRevision?: StartTaskInput['planRevision'] },
  ): Promise<TaskCommandData> {
    return request(`/api/v1/tasks/${encodeURIComponent(taskId)}/${action}`, taskCommandDataSchema, {
      method: 'POST',
      body: input,
    });
  },
  models(repositoryId: string): Promise<ModelListData> {
    return request(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/models`,
      modelListDataSchema,
    );
  },
  branches(repositoryId: string): Promise<RepositoryBranchListData> {
    return request(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/branches`,
      repositoryBranchListDataSchema,
    );
  },
  preferences(repositoryId: string): Promise<RepositoryPreferencesData> {
    return request(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/preferences`,
      repositoryPreferencesDataSchema,
    );
  },
  savePreferences(
    repositoryId: string,
    input: RepositoryPreferencesInput,
  ): Promise<RepositoryPreferencesData> {
    return request(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}/preferences`,
      repositoryPreferencesDataSchema,
      { method: 'PUT', body: input },
    );
  },
};
