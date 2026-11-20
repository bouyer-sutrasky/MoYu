import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ISSUES_VALIDATION_MESSAGE,
  PULLS_VALIDATION_MESSAGE,
  assertListUnchanged,
  assertNoSideEffects,
  classifyRead,
  classifyValidationWrite,
  classifyWrite,
  httpStatus,
  DEFAULT_CONTROL_REPOSITORY,
  invalidRefFor,
  refNonce,
  resolveControlRepository,
} from './gh-probe.mjs';

function result(overrides = {}) {
  return { status: 1, timedOut: false, error: null, stdout: '', stderr: '', ...overrides };
}

const invalidRefMessage = result({
  stdout:
    '{"message":"refs/heads/__m5b_scope_probe__x..__ is not a valid ref name.","status":"422"}',
  stderr: 'gh: refs/heads/__m5b_scope_probe__x..__ is not a valid ref name. (HTTP 422)',
});

test('the probe ref can never be a valid git ref', () => {
  const ref = invalidRefFor('AbC-123');
  assert.match(ref, /^refs\/heads\/__m5b_scope_probe__/);
  assert.ok(ref.includes('..'));
  assert.ok(refNonce(ref));
  assert.ok(!refNonce('refs/heads/main'));
});

test('httpStatus reads the status gh prints in its error summary', () => {
  assert.equal(httpStatus(result({ stderr: 'gh: Not Found (HTTP 404)' })), 404);
  assert.equal(httpStatus(result({ stdout: '{"status":"422"}' })), null);
  assert.equal(httpStatus(result()), null);
});

test('a read is allowed only on a zero exit', () => {
  assert.equal(classifyRead(result({ status: 0 })).kind, 'allowed');
  assert.equal(classifyRead(result({ stderr: 'gh: Not Found (HTTP 404)' })).kind, 'denied');
  assert.equal(
    classifyRead(result({ stderr: 'gh: Resource not accessible (HTTP 403)' })).kind,
    'denied',
  );
  assert.equal(
    classifyRead(result({ stderr: 'To get started with GitHub CLI, please run: gh auth login' }))
      .kind,
    'missing',
  );
  assert.equal(classifyRead(result({ timedOut: true })).kind, 'timeout');
  assert.equal(classifyRead(result({ error: new Error('spawn failed') })).kind, 'exec-error');
  assert.equal(classifyRead(result({ stderr: 'some other failure' })).kind, 'failed');
});

test('only the exact invalid-ref validation proves write authorization', () => {
  assert.equal(classifyWrite(invalidRefMessage).kind, 'allowed');
  assert.equal(classifyWrite(invalidRefMessage).http, 422);

  // A generic 422 or a message containing "invalid" must NOT count as allowed.
  assert.equal(
    classifyWrite(result({ stderr: 'gh: Validation Failed (HTTP 422)' })).kind,
    'failed',
  );
  assert.equal(classifyWrite(result({ stderr: 'gh: invalid request (HTTP 422)' })).kind, 'failed');
  assert.equal(
    classifyWrite(result({ stderr: 'gh: Resource not accessible (HTTP 403)' })).kind,
    'denied',
  );
  assert.equal(classifyWrite(result({ stderr: 'gh: Not Found (HTTP 404)' })).kind, 'denied');
  assert.equal(
    classifyWrite(result({ stderr: 'To get started with GitHub CLI, please run: gh auth login' }))
      .kind,
    'missing',
  );
  assert.equal(classifyWrite(result({ timedOut: true })).kind, 'timeout');
  assert.equal(classifyWrite(result({ error: new Error('spawn failed') })).kind, 'exec-error');
  assert.equal(classifyWrite(result({ stderr: 'some other failure' })).kind, 'failed');
});

test('an unexpected successful write is reported, not treated as authorization', () => {
  assert.equal(classifyWrite(result({ status: 0 })).kind, 'unexpected-success');
});

test('no-side-effect assertion detects refs, pull requests and count changes', () => {
  const before = { refs: ['refs/heads/main'], pulls: ['agent/a'] };
  assert.deepEqual(assertNoSideEffects(before, before), {
    ok: true,
    detail: 'refs=1 pull requests=1',
  });

  const newRef = assertNoSideEffects(before, {
    refs: [...before.refs, invalidRefFor('x')],
    pulls: before.pulls,
  });
  assert.equal(newRef.ok, false);
  assert.match(newRef.detail, /ref with the probe nonce/);

  const newPull = assertNoSideEffects(before, {
    refs: before.refs,
    pulls: [...before.pulls, invalidRefFor('x')],
  });
  assert.equal(newPull.ok, false);
  assert.match(newPull.detail, /pull request with the probe nonce/);

  const countChange = assertNoSideEffects(before, {
    refs: before.refs,
    pulls: [...before.pulls, 'agent/b'],
  });
  assert.equal(countChange.ok, false);
  assert.match(countChange.detail, /pull request count changed/);
});

const issuesMessage = result({
  stdout: '{"message":"Invalid request.\n\n"title" wasn\'t supplied.","status":"422"}',
  stderr: 'gh: Invalid request.\n\n"title" wasn\'t supplied. (HTTP 422)',
});

const pullsMessage = result({
  stdout: '{"message":"Invalid request.\n\n"base", "head" weren\'t supplied.","status":"422"}',
  stderr: 'gh: Invalid request.\n\n"base", "head" weren\'t supplied. (HTTP 422)',
});

test('issues probe requires the exact missing-title validation', () => {
  assert.equal(classifyValidationWrite(issuesMessage, ISSUES_VALIDATION_MESSAGE).kind, 'allowed');
  assert.equal(
    classifyValidationWrite(
      result({ stderr: 'gh: Validation Failed (HTTP 422)' }),
      ISSUES_VALIDATION_MESSAGE,
    ).kind,
    'failed',
  );
  assert.equal(
    classifyValidationWrite(
      result({ stderr: 'gh: Resource not accessible (HTTP 403)' }),
      ISSUES_VALIDATION_MESSAGE,
    ).kind,
    'denied',
  );
  assert.equal(
    classifyValidationWrite(result({ timedOut: true }), ISSUES_VALIDATION_MESSAGE).kind,
    'timeout',
  );
  assert.equal(
    classifyValidationWrite(result({ status: 0 }), ISSUES_VALIDATION_MESSAGE).kind,
    'unexpected-success',
  );
});

test('pull-request probe requires the exact missing head/base validation', () => {
  assert.equal(classifyValidationWrite(pullsMessage, PULLS_VALIDATION_MESSAGE).kind, 'allowed');
  assert.equal(
    classifyValidationWrite(
      result({ stderr: 'gh: Validation Failed (HTTP 422)' }),
      PULLS_VALIDATION_MESSAGE,
    ).kind,
    'failed',
  );
  assert.equal(
    classifyValidationWrite(
      result({ stderr: 'gh: Not Found (HTTP 404)' }),
      PULLS_VALIDATION_MESSAGE,
    ).kind,
    'denied',
  );
  assert.equal(
    classifyValidationWrite(result({ status: 0 }), PULLS_VALIDATION_MESSAGE).kind,
    'unexpected-success',
  );
});

test('collection assertion detects added issues and pull requests', () => {
  assert.deepEqual(assertListUnchanged(['1', '2'], ['1', '2'], 'issue'), {
    ok: true,
    detail: 'issues=2',
  });
  const added = assertListUnchanged(['1', '2'], ['1', '2', '3'], 'issue');
  assert.equal(added.ok, false);
  assert.match(added.detail, /issue count changed/);
  const addedPull = assertListUnchanged(['1'], ['1', '2'], 'pull request');
  assert.equal(addedPull.ok, false);
  assert.match(addedPull.detail, /pull request count changed/);
});

test('the negative control repository is configurable and cannot be a probe repo', () => {
  const probes = ['Bouyer12/m5a-beta-adf10ad9'];
  assert.equal(DEFAULT_CONTROL_REPOSITORY, 'Bouyer12/m5a-epsilon-adf10ad9');
  assert.deepEqual(
    resolveControlRepository({
      flag: 'Bouyer12/control-a',
      env: 'Bouyer12/control-b',
      probeRepositories: probes,
    }),
    { repository: 'Bouyer12/control-a' },
  );
  assert.deepEqual(
    resolveControlRepository({ env: 'Bouyer12/control-b', probeRepositories: probes }),
    { repository: 'Bouyer12/control-b' },
  );
  assert.deepEqual(resolveControlRepository({ probeRepositories: probes }), {
    repository: DEFAULT_CONTROL_REPOSITORY,
  });
  assert.match(
    resolveControlRepository({ flag: '', env: '', probeRepositories: probes }).error,
    /required/,
  );
  assert.match(
    resolveControlRepository({ flag: 'not a repository', probeRepositories: probes }).error,
    /invalid control repository/,
  );
  assert.match(
    resolveControlRepository({ flag: probes[0], probeRepositories: probes }).error,
    /must differ from every probe repository/,
  );
});
