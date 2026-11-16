import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildInstancePrepareCommand } from '../../src/manager';
import { readDeployment } from '../../src/deployment-config';
import { instanceIdentity } from '../../src/store';
import { buildSupervisorServer } from '../../src/server';

const repositoryId = '00000000-0000-4000-8000-000000000001';
const ownerId = '00000000-0000-4000-8000-000000000002';

const PROFILE = `# test profile
- id: dsh-superagent
  config:
    stateDir: /tmp/state/p1
    promptMaxChars: 100000
    admissionContextMaxPages: 10
    admissionContextTimeoutMs: 15000
`;

describe('supervisor settings write boundary', () => {
  let root: string;
  let app: ReturnType<typeof buildSupervisorServer>;
  let instance: {
    repositoryId: string;
    fullName: string;
    state: 'online';
    port: number;
    profile: string;
    createdAt: Date;
  };
  let expectedInstanceId: string;
  let restartCalls: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'moyu-supervisor-boundary-'));
    mkdirSync(join(root, 'profiles', 'p1'), { recursive: true });
    writeFileSync(join(root, 'profiles', 'p1', 'cordis.patch.yml'), PROFILE, { mode: 0o600 });
    instance = {
      repositoryId,
      fullName: 'Bouyer12/settings-boundary',
      state: 'online',
      port: 9,
      profile: 'p1',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    };
    expectedInstanceId = instanceIdentity(instance);
    restartCalls = 0;
    const config = {
      token: 'secret',
      dshHome: root,
      worktreeRoot: join(root, 'worktrees'),
      githubCli: '/opt/moyu/bin/gh-agent',
      githubAllowedUsers: ['Bouyer12'],
      githubAccount: 'Bouyer12',
      githubCommitEmail: 'agent@example.invalid',
    };
    app = buildSupervisorServer({
      config: config as never,
      manager: {
        restart: async () => {
          restartCalls += 1;
          return { restarted: false, reason: 'active work' };
        },
      } as never,
      store: {
        getInstance: async () => instance,
        getRepository: async () => ({
          id: repositoryId,
          ownerId,
          fullName: instance.fullName,
          defaultBranch: 'main',
          bridgeUrl: null,
          bridgeCredentialRef: null,
          checkCommands: null,
          status: 'active',
        }),
      } as never,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const auth = { authorization: 'Bearer secret' };

  it('rejects a missing or stale expected instance before proxying a settings write', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: `/control/v1/instances/${repositoryId}/panel/settings/executor`,
      headers: auth,
      payload: { value: {}, revision: 1 },
    });
    expect(missing.statusCode).toBe(422);

    const stale = await app.inject({
      method: 'PUT',
      url: `/control/v1/instances/${repositoryId}/panel/settings/executor`,
      headers: auth,
      payload: { value: {}, revision: 1, expectedInstanceId: 'old-instance' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'instance_changed' } });
  });

  it('rejects managed executor fields with a field path and does not call the runtime', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/control/v1/instances/${repositoryId}/panel/settings/executor`,
      headers: auth,
      payload: {
        value: { maxWorkers: 2, directory: '/tmp/other', prepare: 'rm -rf /' },
        revision: 1,
        expectedInstanceId,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'managed_field' },
      issues: expect.arrayContaining([
        expect.objectContaining({ path: 'maxWorkers' }),
        expect.objectContaining({ path: 'directory' }),
        expect.objectContaining({ path: 'prepare' }),
      ]),
    });
  });

  it('passes a value with the managed fields intact through to the panel boundary', async () => {
    const prepare = buildInstancePrepareCommand({
      fullName: instance.fullName,
      githubAccount: 'Bouyer12',
      githubCommitEmail: 'agent@example.invalid',
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/control/v1/instances/${repositoryId}/panel/settings/executor`,
      headers: auth,
      payload: {
        value: {
          maxWorkers: 1,
          directory: join(root, 'worktrees', 'p1'),
          prepare,
          blockedCommands: ['rm -rf /'],
        },
        revision: 1,
        expectedInstanceId,
      },
    });
    // The fake port has no runtime; the important point is that validation did
    // not reject the request before the fixed panel call.
    expect(response.statusCode).toBe(503);
  });

  it('serializes two Deployment saves on the same revision and persists the first one', async () => {
    const path = join(root, 'profiles', 'p1', 'cordis.patch.yml');
    const before = readDeployment(readFileSync(path, 'utf8'));
    const payload = {
      ops: [{ op: 'set', path: ['promptMaxChars'], value: 400000 }],
      revision: before.revision,
      expectedInstanceId,
    };
    const [first, second] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: `/control/v1/instances/${repositoryId}/deployment`,
        headers: auth,
        payload,
      }),
      app.inject({
        method: 'PUT',
        url: `/control/v1/instances/${repositoryId}/deployment`,
        headers: auth,
        payload,
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const after = readDeployment(readFileSync(path, 'utf8'));
    expect(after.value.promptMaxChars).toBe(400000);
    expect(restartCalls).toBe(1);
    const ok = first.statusCode === 200 ? first : second;
    expect(ok.json()).toMatchObject({
      data: {
        saved: true,
        restarting: false,
        restartRequired: true,
        snapshot: { instanceId: expectedInstanceId },
      },
    });
  });
});
