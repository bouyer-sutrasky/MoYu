/**
 * Side-effect-free GitHub write-authorization probe for the M5-B matrix precheck.
 *
 * A write can only be proven with an endpoint that requires write permission.
 * The probe posts to `POST /repos/{owner}/{repo}/git/refs` with a ref name that
 * git can never accept (`..` is forbidden in a ref name). GitHub validates the
 * request before creating anything:
 *
 *   - an authorized credential gets HTTP 422 "is not a valid ref name" and no
 *     ref or pull request is created;
 *   - a credential without write access gets HTTP 401/403/404 before validation.
 *
 * The classifier therefore only treats the exact validation message as
 * "allowed"; any other 422 or generic failure stays a failure. Callers assert
 * separately that the repository's refs and pull requests did not gain an entry
 * carrying the probe nonce.
 */

export const INVALID_REF_MESSAGE = /is not a valid ref name/i;
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
 * Classifies the invalid-ref write. A zero exit would mean the ref was created,
 * which must never happen for this name; it is reported as `unexpected-success`
 * so the caller can fail the run instead of treating it as authorization.
 */
export function classifyWrite(result) {
  const early = baseKind(result);
  if (early) return { kind: early, http: null };
  const status = httpStatus(result);
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  if (result?.status === 0) return { kind: 'unexpected-success', http: status };
  if (status === 422 && INVALID_REF_MESSAGE.test(text)) return { kind: 'allowed', http: status };
  if (status === 422)
    return { kind: 'failed', http: status, detail: '422 without the ref-name marker' };
  return { kind: failureKind(result), http: status };
}

/**
 * Compares the refs and pull requests observed before and after the probe.
 * `refs` is the list of ref names; `pulls` the list of pull-request numbers.
 */
export function assertNoSideEffects(before, after) {
  const problems = [];
  if (after.refs.some(refNonce)) problems.push('a ref with the probe nonce exists');
  const pullHead = (pull) => (typeof pull === 'string' ? pull : (pull?.head?.ref ?? ''));
  if (after.pulls.some((pull) => refNonce(pullHead(pull)))) {
    problems.push('a pull request with the probe nonce exists');
  }
  if (after.refs.length !== before.refs.length) {
    problems.push(`ref count changed ${before.refs.length}->${after.refs.length}`);
  }
  if (after.pulls.length !== before.pulls.length) {
    problems.push(`pull count changed ${before.pulls.length}->${after.pulls.length}`);
  }
  return problems.length === 0
    ? { ok: true, detail: `refs=${after.refs.length} pulls=${after.pulls.length}` }
    : { ok: false, detail: problems.join('; ') };
}
