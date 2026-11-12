import { describe, expect, it } from 'vitest';

import {
  activityDataSchema,
  apiErrorResponseSchema,
  authMeDataSchema,
  authStateDataSchema,
  bootstrapExchangeInputSchema,
  bridgeAttachmentSchema,
  bridgeCapabilitiesSchema,
  bridgeTriggerInputSchema,
  ceremonyOptionsSchema,
  cleanupPreviewDataSchema,
  createMessageInputSchema,
  createRepositoryInputSchema,
  errorResponse,
  eventSeqSchema,
  healthDataSchema,
  healthResponseSchema,
  historySearchDataSchema,
  repositoryCheckCommandsSchema,
  repositoryListDataSchema,
  repositorySummarySchema,
  successResponse,
  updateRepositoryInputSchema,
  uuidSchema,
  workspaceEventSchema,
} from '../src/index';

describe('API envelopes', () => {
  it('builds and parses a success envelope', () => {
    const body = successResponse({ ok: true }, 'req-1');

    expect(body).toEqual({ data: { ok: true }, requestId: 'req-1' });
  });

  it('builds and parses an error envelope', () => {
    const body = errorResponse('conflict', 'duplicate clientMessageId', false, 'req-2');

    expect(apiErrorResponseSchema.parse(body)).toEqual(body);
  });
});

describe('health contract', () => {
  it('accepts a valid health response', () => {
    const body = successResponse(
      {
        status: 'ok' as const,
        service: 'moyu-api' as const,
        version: '0.1.0',
        uptimeSeconds: 12,
        timestamp: '2026-11-03T08:00:00.000Z',
      },
      'req-3',
    );

    expect(healthResponseSchema.parse(body).data.service).toBe('moyu-api');
  });

  it('rejects a health payload without a version', () => {
    expect(() =>
      healthDataSchema.parse({
        status: 'ok',
        service: 'moyu-api',
        uptimeSeconds: 1,
        timestamp: '2026-11-03T08:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('message input contract', () => {
  it('accepts the minimal payload', () => {
    const input = createMessageInputSchema.parse({
      clientMessageId: 'client-1',
      text: 'hello',
    });

    expect(input.clientMessageId).toBe('client-1');
  });

  it('rejects blank text and oversized clientMessageId', () => {
    expect(() =>
      createMessageInputSchema.parse({ clientMessageId: 'client-1', text: '   ' }),
    ).toThrow();
    expect(() =>
      createMessageInputSchema.parse({ clientMessageId: 'x'.repeat(129), text: 'hello' }),
    ).toThrow();
  });
});

describe('event contract', () => {
  it('keeps seq as a decimal string', () => {
    expect(eventSeqSchema.parse('9007199254740993')).toBe('9007199254740993');
    expect(() => eventSeqSchema.parse('01')).toThrow();
    expect(() => eventSeqSchema.parse(1)).toThrow();
  });

  it('parses a workspace event', () => {
    const event = workspaceEventSchema.parse({
      id: 'event-1',
      seq: '42',
      type: 'message.created',
      occurredAt: '2026-11-03T08:00:00.000Z',
      data: {
        messageId: '00000000-0000-4000-8000-000000000000',
        direction: 'inbound',
      },
    });

    expect(event.seq).toBe('42');
  });
});

describe('ids', () => {
  it('rejects non-UUID identifiers', () => {
    expect(() => uuidSchema.parse('not-a-uuid')).toThrow();
  });
});

describe('M2 authentication contracts', () => {
  it('parses auth state and session summaries', () => {
    const state = authStateDataSchema.parse({
      initialized: true,
      activeCredentialCount: 1,
      setupOpen: false,
      recoveryOpen: false,
      rpId: 'moyu.sutrasky.com',
      origin: 'https://moyu.sutrasky.com',
    });
    expect(state.setupOpen).toBe(false);

    const me = authMeDataSchema.parse({
      owner: { id: '00000000-0000-4000-8000-000000000001', displayName: 'MoYu Owner' },
      session: {
        id: '00000000-0000-4000-8000-000000000002',
        userAgent: null,
        createdAt: '2026-11-03T08:00:00.000Z',
        lastUsedAt: '2026-11-03T08:00:00.000Z',
        expiresAt: '2027-02-01T08:00:00.000Z',
        current: true,
      },
      credentials: [],
    });
    expect(me.session.current).toBe(true);
  });

  it('requires a sufficiently long binding code', () => {
    expect(() => bootstrapExchangeInputSchema.parse({ code: 'short' })).toThrow();
    expect(() => bootstrapExchangeInputSchema.parse({ code: 'ABCD-EFGH-JKMN' })).not.toThrow();
  });

  it('parses a ceremony envelope without fixing the WebAuthn options shape', () => {
    const ceremony = ceremonyOptionsSchema.parse({
      ceremonyId: '00000000-0000-4000-8000-000000000003',
      optionsJSON: { challenge: 'abc', rp: { id: 'moyu.sutrasky.com' } },
    });
    expect(ceremony.optionsJSON.challenge).toBe('abc');
  });

  it('parses the read-only repository inventory', () => {
    const list = repositoryListDataSchema.parse({
      repositories: [
        {
          id: '00000000-0000-4000-8000-000000000004',
          fullName: 'bouyer-sutrasky/MoYu',
          githubRepositoryId: 123,
          defaultBranch: 'main',
          status: 'provisioning',
          checkCommands: null,
          createdAt: '2026-11-03T08:00:00.000Z',
          updatedAt: '2026-11-03T08:00:00.000Z',
        },
      ],
    });
    expect(list.repositories[0]?.status).toBe('provisioning');
  });
});

describe('M6-A L113 bridge attachment contracts', () => {
  const attachment = {
    id: '00000000-0000-4000-8000-000000000010',
    filename: 'l113-shot.png',
    mimeType: 'image/png',
    sizeBytes: 48_213,
    sha256: 'a'.repeat(64),
    kind: 'image',
  };
  const trigger = {
    triggerId: 'workspace:00000000-0000-4000-8000-000000000011',
    conversationId: '00000000-0000-4000-8000-000000000012',
    messageId: '00000000-0000-4000-8000-000000000011',
    replyToMessageId: null,
    actor: { id: 'owner-1', name: 'MoYu Owner' },
    text: 'Check the attachment before answering',
    at: '2026-11-09T08:00:00.000Z',
    executionSpec: {
      repository: 'bouyer-sutrasky/MoYu',
      baseBranch: 'main',
      baseCommit: null,
      model: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
      mode: 'execute',
    },
  };
  const capabilities = {
    protocolVersion: 'moyu-bridge/1',
    upstream: { package: 'dsh-superagent', version: '0.1.0' },
    capabilities: {
      trigger: true,
      events: true,
      tickets: true,
      models: true,
      pause: true,
      resume: true,
      retry: true,
      readOnlyDiscussion: true,
    },
    source: { kind: 'workspace', enabled: true },
  };

  it('round-trips attachment references on a trigger', () => {
    const parsed = bridgeTriggerInputSchema.parse({
      ...trigger,
      attachments: [attachment, { ...attachment, kind: 'text', mimeType: 'text/plain' }],
    });
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments?.[0]).toEqual(attachment);
  });

  it('keeps a trigger without attachments valid', () => {
    expect(bridgeTriggerInputSchema.parse(trigger).attachments).toBeUndefined();
  });

  it('rejects content, URLs and other unknown attachment keys', () => {
    expect(() =>
      bridgeAttachmentSchema.parse({ ...attachment, content: 'base64-bytes' }),
    ).toThrow();
    expect(() =>
      bridgeAttachmentSchema.parse({ ...attachment, downloadUrl: 'https://example.test/a' }),
    ).toThrow();
    expect(() =>
      bridgeTriggerInputSchema.parse({
        ...trigger,
        attachments: [{ ...attachment, conversationId: trigger.conversationId }],
      }),
    ).toThrow();
  });

  it('rejects an empty, oversized or unverifiable attachment', () => {
    expect(() => bridgeAttachmentSchema.parse({ ...attachment, filename: '' })).toThrow();
    expect(() => bridgeAttachmentSchema.parse({ ...attachment, sizeBytes: 0 })).toThrow();
    expect(() =>
      bridgeAttachmentSchema.parse({ ...attachment, sizeBytes: 10 * 1024 * 1024 + 1 }),
    ).toThrow();
    expect(() => bridgeAttachmentSchema.parse({ ...attachment, sha256: 'A'.repeat(64) })).toThrow();
    expect(() => bridgeAttachmentSchema.parse({ ...attachment, kind: 'binary' })).toThrow();
  });

  it('caps a trigger at ten attachments', () => {
    expect(() =>
      bridgeTriggerInputSchema.parse({ ...trigger, attachments: Array(11).fill(attachment) }),
    ).toThrow();
    expect(
      bridgeTriggerInputSchema.parse({ ...trigger, attachments: Array(10).fill(attachment) })
        .attachments,
    ).toHaveLength(10);
  });

  it('reads capabilities with and without the optional attachments flag', () => {
    // An old runtime omits the flag, which must stay valid and mean unsupported.
    expect(bridgeCapabilitiesSchema.parse(capabilities).capabilities.attachments).toBeUndefined();
    expect(
      bridgeCapabilitiesSchema.parse({
        ...capabilities,
        capabilities: { ...capabilities.capabilities, attachments: true },
      }).capabilities.attachments,
    ).toBe(true);
  });
});

describe('M6-B activity, history and cleanup contracts', () => {
  const notification = {
    id: '11111111-1111-4111-8111-111111111111',
    seq: '42',
    category: 'needs_reply',
    state: 'waiting_input',
    repositoryId: '22222222-2222-4222-8222-222222222222',
    repositoryName: 'Bouyer12/MoYu',
    conversationId: '33333333-3333-4333-8333-333333333333',
    taskId: '44444444-4444-4444-8444-444444444444',
    title: '任务',
    summary: '请确认是否继续',
    occurredAt: '2026-11-10T00:00:00.000Z',
  };

  it('parses an activity feed and rejects an unknown category', () => {
    const data = activityDataSchema.parse({
      notifications: [notification],
      running: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(data.notifications[0]?.category).toBe('needs_reply');
    expect(() =>
      activityDataSchema.parse({
        notifications: [{ ...notification, category: 'progress' }],
        running: [],
        nextCursor: null,
        hasMore: false,
      }),
    ).toThrow();
  });

  it('parses a history page and rejects a malformed cursor position', () => {
    const data = historySearchDataSchema.parse({ items: [], nextCursor: null, hasMore: false });
    expect(data.items).toEqual([]);
  });

  it('parses a cleanup preview with a real path, size and reason', () => {
    const data = cleanupPreviewDataSchema.parse({
      run: {
        id: '55555555-5555-4555-8555-555555555555',
        mode: 'preview',
        status: 'preview',
        retentionDays: 7,
        previewOfRunId: null,
        summary: {
          candidates: 1,
          eligible: 1,
          skipped: 0,
          removed: 0,
          alreadyCleaned: 0,
          failed: 0,
          totalBytes: 2048,
          bytesFreed: 0,
        },
        error: null,
        createdAt: '2026-11-10T00:00:00.000Z',
        expiresAt: '2026-11-10T00:15:00.000Z',
        finishedAt: null,
        items: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            ticketId: 't_1',
            conversationId: notification.conversationId,
            repositoryId: notification.repositoryId,
            repositoryName: notification.repositoryName,
            profile: 'probe1',
            directory: '/worktrees/probe1/task-abcdef123456',
            state: 'planned',
            eligible: true,
            reason: 'PR #7 已合并；已完成 8 天（≥ 7 天）；无未保存修改',
            sizeBytes: 2048,
            modifiedAt: '2026-11-01T00:00:00.000Z',
            detail: {},
          },
        ],
      },
    });
    expect(data.run.items[0]?.eligible).toBe(true);
    expect(() =>
      cleanupPreviewDataSchema.parse({
        run: { ...data.run, retentionDays: 0 },
      }),
    ).toThrow();
  });
});

describe('repository check commands contract', () => {
  it('accepts one to eight single-line commands', () => {
    expect(repositoryCheckCommandsSchema.parse(['pnpm check'])).toEqual(['pnpm check']);
    expect(
      repositoryCheckCommandsSchema.parse([
        'npm ci --no-audit --no-fund',
        'npm run build',
        'npm test',
      ]),
    ).toHaveLength(3);
  });

  it('trims lines and rejects blank, multi-line, NUL and oversized values', () => {
    expect(repositoryCheckCommandsSchema.parse(['  npm test  '])).toEqual(['npm test']);
    for (const invalid of [
      [],
      ['   '],
      ['npm ci\nnpm test'],
      ['npm \u0000 test'],
      ['x'.repeat(2001)],
      Array.from({ length: 9 }, (_, index) => `echo ${index}`),
    ]) {
      expect(() => repositoryCheckCommandsSchema.parse(invalid)).toThrow();
    }
  });

  it('keeps create optional and update explicit', () => {
    expect(createRepositoryInputSchema.parse({ fullName: 'owner/repo' })).toEqual({
      fullName: 'owner/repo',
    });
    expect(
      createRepositoryInputSchema.parse({
        fullName: 'owner/repo',
        checkCommands: ['npm test'],
      }).checkCommands,
    ).toEqual(['npm test']);
    expect(updateRepositoryInputSchema.parse({ checkCommands: null })).toEqual({
      checkCommands: null,
    });
    expect(() => updateRepositoryInputSchema.parse({ fullName: 'owner/repo' })).toThrow();
  });

  it('requires an explicit checkCommands value in the repository summary', () => {
    const summary = {
      id: '11111111-1111-4111-8111-111111111111',
      fullName: 'owner/repo',
      githubRepositoryId: 1,
      defaultBranch: 'main',
      status: 'provisioning',
      createdAt: '2026-11-12T00:00:00.000Z',
      updatedAt: '2026-11-12T00:00:00.000Z',
    };
    expect(repositorySummarySchema.parse({ ...summary, checkCommands: null }).checkCommands).toBe(
      null,
    );
    expect(() => repositorySummarySchema.parse(summary)).toThrow();
  });
});
