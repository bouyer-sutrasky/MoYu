import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWorkspaceRoute,
  sameWorkspaceRoute,
  workspaceRouteSearch,
  workspaceRouteUrl,
} from './workspaceRoute.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('an empty search restores no target and no settings dialog', () => {
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

test('an unknown settings section leaves the dialog closed and ignores its sub-keys', () => {
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
