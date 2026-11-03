import {
  bridgeCapabilitiesSchema,
  bridgeEventPageSchema,
  bridgeModelListSchema,
  bridgeTriggerInputSchema,
  bridgeTriggerResultSchema,
  type BridgeCapabilities,
  type BridgeEventPage,
  type BridgeModelList,
  type BridgeTriggerInput,
  type BridgeTriggerResult,
} from '@moyu/contracts';
import type { z } from 'zod';

/**
 * HTTP client for the repository's private machine Bridge. It only consumes the
 * MoYu Bridge protocol documented in docs/M3-BRIDGE-PROTOCOL.md; it never
 * imports upstream superagent code or browser credentials.
 */
export type {
  BridgeCapabilities,
  BridgeEvent,
  BridgeEventPage,
  BridgeModelList,
  BridgeTriggerInput,
  BridgeTriggerResult,
} from '@moyu/contracts';

export class RuntimeBridgeError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number | null; code?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'RuntimeBridgeError';
    this.status = options.status ?? null;
    this.code = options.code ?? 'bridge_unavailable';
    this.retryable = options.retryable ?? true;
  }
}

export interface RuntimeBridgeClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export class RuntimeBridgeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RuntimeBridgeClientOptions) {
    if (!options.baseUrl) {
      throw new Error('Bridge base URL is required');
    }
    if (!options.token) {
      throw new Error('Bridge token is required');
    }
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async capabilities(signal?: AbortSignal): Promise<BridgeCapabilities> {
    return this.request('/bridge/v1/capabilities', bridgeCapabilitiesSchema, { signal });
  }

  async models(signal?: AbortSignal): Promise<BridgeModelList> {
    return this.request('/bridge/v1/models', bridgeModelListSchema, { signal });
  }

  async trigger(input: BridgeTriggerInput, signal?: AbortSignal): Promise<BridgeTriggerResult> {
    const body = bridgeTriggerInputSchema.parse(input);
    return this.request('/bridge/v1/triggers', bridgeTriggerResultSchema, {
      method: 'POST',
      body,
      signal,
      // A duplicate trigger is not an error, and a slow model acceptance must
      // not be mistaken for a lost delivery: the Bridge answers synchronously.
      timeoutMs: 30_000,
    });
  }

  async events(
    after: bigint | number,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<BridgeEventPage> {
    const query = new URLSearchParams({ after: after.toString(), limit: String(limit) });
    return this.request(`/bridge/v1/events?${query.toString()}`, bridgeEventPageSchema, { signal });
  }

  async ticket(ticketId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      `/bridge/v1/tickets/${encodeURIComponent(ticketId)}`,
      {
        safeParse(value: unknown) {
          return { success: true as const, data: value };
        },
      } as unknown as z.ZodType<unknown>,
      { signal },
    );
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST';
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch {
      throw new RuntimeBridgeError('The runtime Bridge could not be reached', {
        retryable: true,
        code: 'bridge_unreachable',
      });
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const envelope = payload as {
        error?: { code?: string; message?: string; retryable?: boolean };
      } | null;
      throw new RuntimeBridgeError(
        envelope?.error?.message ?? `Runtime Bridge returned HTTP ${response.status}`,
        {
          status: response.status,
          code: envelope?.error?.code ?? 'bridge_error',
          retryable:
            envelope?.error?.retryable ??
            (response.status >= 500 || response.status === 408 || response.status === 429),
        },
      );
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new RuntimeBridgeError('Runtime Bridge response did not match the shared contract', {
        status: response.status,
        code: 'bridge_invalid_response',
        retryable: false,
      });
    }
    return parsed.data;
  }
}

/** Platform-to-idle-model helper: encode a selected model identity in one stable string. */
export function encodeModelId(selection: { provider: string; model: string }): string {
  return `${selection.provider}/${selection.model}`;
}

/** Decode `provider/model`. The provider is the first path segment; model may contain slashes. */
export function decodeModelId(value: string | null): { provider: string; model: string } | null {
  if (!value) {
    return null;
  }
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return null;
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}
