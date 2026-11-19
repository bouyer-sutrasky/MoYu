import { describe, expect, it } from 'vitest';

import type { RepositoryGitPreparation } from '@moyu/contracts';

import { activationFor } from '../../src/domain/instances';
import type { SupervisorInstance } from '../../src/runtime/supervisor';

function instance(overrides: Partial<SupervisorInstance> = {}): SupervisorInstance {
  return {
    repositoryId: '11111111-1111-4111-8111-111111111111',
    state: 'starting',
    desiredState: 'online',
    reasonCode: 'starting',
    reasonDetail: null,
    waitingFor: 'runtime',
    queuePriority: 20,
    wakeRequestedAt: '2026-11-19T10:00:00.000Z',
    activationRequestedAt: '2026-11-19T10:00:00.000Z',
    lastActivityAt: null,
    lastProgressAt: null,
    lastStartedAt: '2026-11-19T10:00:01.000Z',
    lastOnlineAt: null,
    lastStoppedAt: null,
    lastHealthAt: null,
    pid: 100,
    port: 4000,
    profile: 'p1',
    attemptCount: 1,
    errorCode: null,
    errorDetail: null,
    gitState: 'preparing',
    gitPhase: 'receiving',
    gitProgress: 40,
    gitDetail: '正在接收对象 40%',
    gitStartedAt: '2026-11-19T10:00:00.000Z',
    gitFinishedAt: null,
    gitAttempts: 1,
    gitHead: null,
    updatedAt: '2026-11-19T10:00:02.000Z',
    ...overrides,
  };
}

function preparation(overrides: Partial<RepositoryGitPreparation> = {}): RepositoryGitPreparation {
  return {
    state: 'preparing',
    phase: 'receiving',
    progress: 40,
    detail: '正在接收对象 40%',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: null,
    attempts: 1,
    headCommit: null,
    ...overrides,
  };
}

describe('activation phase priority', () => {
  it('reports repository preparation while the runtime and Git copy both start', () => {
    const activation = activationFor(
      instance({ state: 'starting', gitState: 'preparing' }),
      preparation(),
      new Date('2026-11-19T10:00:05.000Z'),
    );
    expect(activation.phase).toBe('preparing');
    expect(activation.detail).toBe('正在接收对象 40%');
    expect(activation.elapsedMs).toBe(5000);
    expect(activation.retryAction).toBeNull();
  });

  it('reports preparation even when the process already reached online', () => {
    const activation = activationFor(
      instance({
        state: 'online',
        gitState: 'preparing',
        lastOnlineAt: '2026-11-19T10:00:03.000Z',
      }),
      preparation({ phase: 'resolving', progress: null, detail: '正在解析增量' }),
      new Date('2026-11-19T10:00:05.000Z'),
    );
    expect(activation.phase).toBe('preparing');
    expect(activation.detail).toBe('正在解析增量');
    expect(activation.readyMs).toBe(3000);
  });

  it('reports starting once the copy is ready but the runtime is not online', () => {
    const activation = activationFor(
      instance({ state: 'starting' }),
      preparation({ state: 'ready', phase: 'ready', progress: 100, detail: '副本已就绪' }),
      new Date('2026-11-19T10:00:05.000Z'),
    );
    expect(activation.phase).toBe('starting');
    expect(activation.detail).toBeNull();
  });

  it('keeps a preparation failure failed even while the runtime is starting', () => {
    const activation = activationFor(
      instance({ state: 'starting', gitState: 'failed' }),
      preparation({ state: 'failed', detail: '远端不可达' }),
      new Date('2026-11-19T10:00:05.000Z'),
    );
    expect(activation.phase).toBe('failed');
    expect(activation.detail).toBe('远端不可达');
    expect(activation.retryAction).toBe('prepare');
  });
});
