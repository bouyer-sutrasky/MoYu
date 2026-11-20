/**
 * Side-effect-free GitHub write-authorization probes for the M5-B matrix precheck.
 *
 * A write can only be proven with an endpoint that requires write permission.
 * Each probe posts a request that GitHub must reject with a *specific* validation
 * error before creating anything:
 *
 *   - Git refs: `POST /repos/{owner}/{repo}/git/refs` with a ref name containing
 *     `..`, which git can never accept (`is not a valid ref name`);
 *   - Issues: `POST /repos/{owner}/{repo}/issues` without a title
 *     (`"title" wasn't supplied`);
 *   - Pull requests: `POST /repos/{owner}/{repo}/pulls` without head/base
 *     (`"base", "head" weren't supplied`).
 *
 * An authorized credential gets HTTP 422 with exactly that message; a credential
 * without the scope gets 401/403/404 before validation. Only the endpoint's exact
 * validation message counts as "allowed"; every other 422 stays a failure. A
 * zero exit would mean something was created and is reported as
 * `unexpected-success`. Callers additionally read the corresponding collection
 * before and after and assert that nothing was added.
 */

export const INVALID_REF_MESSAGE = /is not a valid ref name/i;
export const ISSUES_VALIDATION_MESSAGE = /"title" wasn't supplied|title.*wasn't supplied/i;
export const PULLS_VALIDATION_MESSAGE =
  /"base",\s*"head" weren't supplied|"head" wasn't supplied|"base" wasn't supplied/i;
export const AUTH_MISSING_MESSAGE =
  /gh auth login|not logged in|no oauth token|authentication required|To get started with GitHub CLI/i;

export const INVALID_REF_PREFIX = 'refs/heads/__m5b_scope_probe__';

/** A ref name git forbids (`..`), so it cannot exist before or after the probe. */
export function invalidRefFor(nonce) {
  const safe = String(nonce).replace(/[^A-Za-z0-9]/g, '');
  return `${INVALID_REF_PREFIX}${safe}..__`;
}

export function refNonce(ref) {
  return String(ref).includes(INVALID_REF_PREFIX);
}

/** Reads the HTTP status that `gh` prints in its error summary. */
export function httpStatus(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  const match = /\(HTTP (\d{3})\)/.exec(text) ?? /HTTP (\d{3})/.exec(text);
  return match ? Number(match[1]) : null;
}

function baseKind(result) {
  if (result?.timedOut) return 'timeout';
  if (result?.error) return 'exec-error';
  return null;
}

function failureKind(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  const status = httpStatus(result);
  if (status === 401 || status === 403 || status === 404) return 'denied';
  if (AUTH_MISSING_MESSAGE.test(text)) return 'missing';
  return 'failed';
}

/** Classifies a read-only call: `denied` is a known permission outcome. */
export function classifyRead(result) {
  const early = baseKind(result);
  if (early) return { kind: early, http: null };
  if (result?.status === 0) return { kind: 'allowed', http: null };
  return { kind: failureKind(result), http: httpStatus(result) };
}

/**
 * Classifies a write whose invalid payload must produce one exact validation
 * message. A generic 422 is a failure, never authorization.
 */
export function classifyValidationWrite(result, allowedMessage) {
  const early = baseKind(result);
  if (early) return { kind: early, http: null };
  const status = httpStatus(result);
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  if (result?.status === 0) return { kind: 'unexpected-success', http: status };
  if (status === 422 && allowedMessage.test(text)) return { kind: 'allowed', http: status };
  if (status === 422) {
    return { kind: 'failed', http: status, detail: '422 without the expected validation marker' };
  }
  return { kind: failureKind(result), http: status };
}

/** Git-refs probe classification (kept as the named endpoint classifier). */
export function classifyWrite(result) {
  return classifyValidationWrite(result, INVALID_REF_MESSAGE);
}

/**
 * Compares one collection before and after a probe. `items` are strings (ref
 * names, issue numbers, pull-request numbers); the probe nonce must not appear
 * and the count must not change.
 */
export function assertListUnchanged(before, after, label) {
  const problems = [];
  if (after.some((item) => refNonce(item))) problems.push(`a ${label} with the probe nonce exists`);
  if (after.length !== before.length) {
    problems.push(`${label} count changed ${before.length}->${after.length}`);
  }
  return problems.length === 0
    ? { ok: true, detail: `${label}s=${after.length}` }
    : { ok: false, detail: problems.join('; ') };
}

/** Ref probe: refs and pull requests must both stay unchanged. */
export function assertNoSideEffects(before, after) {
  const refs = assertListUnchanged(before.refs, after.refs, 'ref');
  const pulls = assertListUnchanged(before.pulls, after.pulls, 'pull request');
  return refs.ok && pulls.ok
    ? { ok: true, detail: `${refs.detail} ${pulls.detail}` }
    : {
        ok: false,
        detail: [...(refs.ok ? [] : [refs.detail]), ...(pulls.ok ? [] : [pulls.detail])].join('; '),
      };
}
