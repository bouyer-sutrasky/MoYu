import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPermanentTargetFailure,
  parseWorkspaceRoute,
  sameWorkspaceRoute,
  workspaceRouteSearch,
  workspaceRouteUrl,
} from './workspaceRoute.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('an empty search restores no target and no management page', () => {
  assert.deepEqual(parseWorkspaceRoute(''), {
    repositoryId: null,
    conversationId: null,
    settings: null,
  });
  assert.deepEqual(parseWorkspaceRoute('?'), {
    repositoryId: null,
    conversationId: null,
    settings: null,
  });
});

test('parses the workbench repository and conversation only when they are UUIDs', () => {
  assert.deepEqual(parseWorkspaceRoute(`?repo=${A}&conversation=${B}`), {
    repositoryId: A,
    conversationId: B,
    settings: null,
  });
  assert.deepEqual(parseWorkspaceRoute('?repo=beta&conversation=../../etc/passwd'), {
    repositoryId: null,
    conversationId: null,
    settings: null,
  });
  assert.deepEqual(parseWorkspaceRoute(`?repo=${A}&conversation=${'x'.repeat(201)}`), {
    repositoryId: A,
    conversationId: null,
    settings: null,
  });
});

test('restores a settings section, its independent repository and its group', () => {
  assert.deepEqual(
    parseWorkspaceRoute(`?repo=${A}&settings=superagent&settingsRepo=${B}&group=eval`),
    {
      repositoryId: A,
      conversationId: null,
      settings: { section: 'superagent', repositoryId: B, group: 'eval' },
    },
  );
  // An unknown group falls back to the group default, not to the workbench repository.
  assert.deepEqual(parseWorkspaceRoute(`?settings=superagent&settingsRepo=${B}&group=unknown`), {
    repositoryId: null,
    conversationId: null,
    settings: { section: 'superagent', repositoryId: B, group: null },
  });
});

test('an unknown settings section leaves the settings page closed and ignores its sub-keys', () => {
  assert.deepEqual(parseWorkspaceRoute(`?settings=bogus&settingsRepo=${B}&group=eval`), {
    repositoryId: null,
    conversationId: null,
    settings: null,
  });
  assert.deepEqual(parseWorkspaceRoute(`?settingsRepo=${B}&group=eval`), {
    repositoryId: null,
    conversationId: null,
    settings: null,
  });
});

test('serializes in a stable order and round-trips every addressable field', () => {
  const route = {
    repositoryId: C,
    conversationId: A,
    settings: { section: 'superagent', repositoryId: B, group: 'prompts' },
  };
  assert.equal(
    workspaceRouteSearch(route),
    `?repo=${C}&conversation=${A}&settings=superagent&settingsRepo=${B}&group=prompts`,
  );
  assert.deepEqual(parseWorkspaceRoute(workspaceRouteSearch(route)), route);
  assert.equal(workspaceRouteUrl('/work', route), `/work${workspaceRouteSearch(route)}`);
});

test('comparison uses the serialized address, not object identity', () => {
  const left = { repositoryId: A, conversationId: null, settings: null };
  assert.equal(sameWorkspaceRoute(left, { ...left }), true);
  assert.equal(sameWorkspaceRoute(left, { ...left, conversationId: B }), false);
});

test('only a confirmed 403/404 target failure may canonicalize the address away', () => {
  assert.equal(isPermanentTargetFailure(403), true);
  assert.equal(isPermanentTargetFailure(404), true);
  // Transient API failures must keep the deep link for refresh/retry.
  for (const status of [null, 0, 400, 401, 408, 422, 429, 500, 502, 503, 504]) {
    assert.equal(isPermanentTargetFailure(status), false, `status ${status}`);
  }
});

test('repository management has an independent target and canonical address', () => {
  const search = `?repo=${A}&conversation=${C}&view=repositories&manageRepo=${B}`;
  const route = parseWorkspaceRoute(search + '&settings=activity');
  assert.deepEqual(route, {
    repositoryId: A,
    conversationId: C,
    settings: null,
    repositories: { repositoryId: B },
  });
  assert.equal(workspaceRouteSearch(route), search);
  assert.equal(
    parseWorkspaceRoute('?view=repositories&manageRepo=bad').repositories.repositoryId,
    null,
  );
  assert.equal(parseWorkspaceRoute(`?view=bogus&manageRepo=${B}`).repositories, undefined);
});

test('legacy SuperAgent URLs retain the Work conversation and in-group focus', () => {
  const search = `?repo=${A}&conversation=${C}&settings=superagent&settingsRepo=${B}&group=eval&version=012abc`;
  assert.deepEqual(parseWorkspaceRoute(search).settings, {
    section: 'superagent',
    repositoryId: B,
    group: 'eval',
    version: '012abc',
  });
  assert.equal(workspaceRouteSearch(parseWorkspaceRoute(search)), search);
  assert.equal(
    parseWorkspaceRoute('?settings=superagent&group=source&source=github').settings.source,
    'github',
  );
  assert.equal(
    parseWorkspaceRoute(`?settings=superagent&source=${'a'.repeat(201)}`).settings.source,
    undefined,
  );
  assert.equal(parseWorkspaceRoute('?settings=account&source=github').settings.source, undefined);
});
