import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertNoSideEffects,
  classifyRead,
  classifyWrite,
  httpStatus,
  invalidRefFor,
  refNonce,
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
    detail: 'refs=1 pulls=1',
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
  assert.match(countChange.detail, /pull count changed/);
});
