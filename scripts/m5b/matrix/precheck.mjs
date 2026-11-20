#!/usr/bin/env node
/**
 * Read-only isolation precheck for the M5-B on-site matrix.
 *
 * Answers, before any matrix rerun:
 *
 *   - can the dedicated test identity write host configuration or read a shared
 *     credential?                                       (must be no)
 *   - are its SSH and gh credentials dedicated, and do they actually reach only
 *     the probe repositories?                            (`--online` / `--gate`)
 *   - do privileged bootstrap files live outside the matrix-writable tree, and
 *     is stale privileged state left from an earlier layout?
 *
 * Scope probes do not change remote state: the SSH key is checked with
 * `git push --dry-run` (no refs are updated), and the gh token with a write
 * request whose ref name (`..`) can never be valid. An authorized token gets a
 * 422 "is not a valid ref name" validation response and GitHub creates nothing;
 * an unauthorized one gets 401/403/404 before validation. Only that exact
 * validation message counts as authorization, and the precheck additionally
 * asserts that no ref or pull request carrying the probe nonce appeared. The
 * result distinguishes "allowed", "denied", "missing credential",
 * "execution error", "timeout" and "other failure" instead of treating every
 * non-zero exit as a denial.
 *
 * `--gate` runs only the credential/scope gate that `stack.sh up` calls before
 * starting a unit. The script never writes host configuration and never prints
 * token material.
 *
 * Exit codes: 0 clean/authorized, 1 isolation violation or missing credential,
 * 2 evidence incomplete (a probe could not run).
 */
import {
  chownSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  ISSUES_VALIDATION_MESSAGE,
  PULLS_VALIDATION_MESSAGE,
  assertListUnchanged,
  assertNoSideEffects,
  classifyRead,
  classifyValidationWrite,
  classifyWrite,
  invalidRefFor,
} from './gh-probe.mjs';
import {
  HOST_READ_ONLY_PATHS,
  HOST_SECRET_PATHS,
  IsolationGuardError,
  assertDedicatedGhConfig,
  assertDedicatedSshKey,
  auditHost,
  describePath,
  layoutFor,
  redact,
  resolveUser,
} from './guard.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((value) => value.startsWith('--')));
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return fallback;
};

const json = flags.has('--json');
const gate = flags.has('--gate');
const online = flags.has('--online') || gate;
const userName = option('user', 'm5bmatrix');
const runDir = option('run', '/tmp/m5bmatrix');
const layout = layoutFor(runDir, process.env);
const sshKey = option(
  'ssh-key',
  process.env.M5B_MATRIX_SSH_KEY ?? '/root/.config/m5bmatrix/probe_ssh_key',
);
const ghConfigDir = option(
  'gh-config',
  process.env.M5B_MATRIX_GH_CONFIG_DIR ?? '/root/.config/m5bmatrix/gh',
);
const matrixHome = `/home/${userName}`;
const probeRepositories = [
  option('repository', 'Bouyer12/m5a-beta-adf10ad9'),
  ...String(process.env.M5B_MATRIX_EXTRA_REPOS ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':')[0]),
];
const forbiddenRepository = 'bouyer-sutrasky/MoYu';
const credentialEnvNames = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'];

const checks = [];
const findings = [];
const incomplete = [];

function record(section, name, status, detail) {
  checks.push({ section, name, status, detail });
  if (status === 'FAIL') findings.push({ section, name, detail });
  if (status === 'INCOMPLETE') incomplete.push({ section, name, detail });
}

function matrixIdentity() {
  try {
    return resolveUser(userName);
  } catch {
    return null;
  }
}

/**
 * Unified execution entry: every probe that must run as the matrix identity
 * goes through here, including the same-user case used by tests.
 */
function runAsMatrix(args, { timeoutMs = 30000 } = {}) {
  const env = { ...process.env, HOME: matrixHome };
  const current = userInfo().username;
  let result;
  if (current === userName) {
    result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: timeoutMs, env });
  } else {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      return { status: null, error: new Error(`cannot run as ${userName} without root`), args };
    }
    result = spawnSync('runuser', ['-u', userName, '--', ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env,
    });
  }
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    args,
  };
}

function classify(result) {
  if (result.timedOut) return 'timeout';
  if (result.error) return 'exec-error';
  if (result.status === 0) return 'allowed';
  const text = `${result.stdout}\n${result.stderr}`;
  if (
    /Permission denied|Permission to .* denied|denied to deploy key|could not read Username|Authentication failed|Repository not found|not found|HTTP 40[13]|Resource not accessible|must have push|gh auth login/i.test(
      text,
    )
  ) {
    return 'denied';
  }
  return 'failed';
}

function firstLine(text) {
  return redact(
    String(text)
      .split('\n')
      .find((line) => line.trim()) ?? '',
  ).slice(0, 140);
}

function hostAudit(identity) {
  if (!identity) return null;
  const audit = auditHost({
    identity,
    paths: HOST_READ_ONLY_PATHS,
    secretPaths: HOST_SECRET_PATHS,
  });
  const probeAvailable = process.getuid() === 0;
  for (const path of HOST_READ_ONLY_PATHS) {
    const facts = describePath(path);
    const access = auditHost({ identity, paths: [path], secretPaths: [] });
    const computed = access.writeViolations.length > 0 ? 'writable' : 'not-writable';
    let observed = 'not-probed';
    if (probeAvailable) {
      observed = runAsMatrix(['test', '-w', path]).status === 0 ? 'writable' : 'not-writable';
    }
    record(
      'host-boundary',
      path,
      computed === 'writable' || observed === 'writable' ? 'FAIL' : 'PASS',
      `owner=${facts.uid ?? '?'} mode=${facts.mode ?? 'missing'} computed=${computed} observed=${observed}`,
    );
  }
  for (const path of HOST_SECRET_PATHS) {
    const facts = describePath(path);
    const access = auditHost({ identity, paths: [], secretPaths: [path] });
    const computed = access.readViolations.length > 0 ? 'readable' : 'not-readable';
    let observed = 'not-probed';
    if (probeAvailable && facts.exists) {
      observed = runAsMatrix(['test', '-r', path]).status === 0 ? 'readable' : 'not-readable';
    }
    record(
      'host-boundary',
      path,
      computed === 'readable' || observed === 'readable' ? 'FAIL' : 'PASS',
      `mode=${facts.mode ?? 'missing'} computed=${computed} observed=${observed}`,
    );
  }
  return { identity, audit };
}

function credentialAudit(identity) {
  let key = null;
  try {
    key = assertDedicatedSshKey({ keyPath: sshKey, hostKeyDir: '/root/.ssh', uid: identity.uid });
    record(
      'credentials',
      `ssh-key:${sshKey}`,
      'PASS',
      `sha256=${key.sha256} mode=${key.mode.toString(8)}`,
    );
  } catch (error) {
    const missing = /does not exist/.test(error.message);
    record(
      'credentials',
      `ssh-key:${sshKey}`,
      missing ? 'INCOMPLETE' : error instanceof IsolationGuardError ? 'FAIL' : 'INCOMPLETE',
      redact(error.message),
    );
  }
  try {
    const config = assertDedicatedGhConfig({
      configDir: ghConfigDir,
      hostConfigDirs: ['/root/.config/gh-agent'],
      uid: identity.uid,
    });
    record(
      'credentials',
      `gh-config:${config.path}`,
      'PASS',
      `token=present sha256=${config.tokenSha256} (value not printed)`,
    );
  } catch (error) {
    const missing = /does not exist|carries no token/.test(error.message);
    record(
      'credentials',
      `gh-config:${ghConfigDir}`,
      missing ? 'INCOMPLETE' : error instanceof IsolationGuardError ? 'FAIL' : 'INCOMPLETE',
      redact(error.message),
    );
  }
  for (const name of credentialEnvNames) {
    if (process.env[name]) {
      record(
        'credentials',
        `env:${name}`,
        'FAIL',
        `${name} is set in the harness environment and would override the dedicated gh config`,
      );
    }
  }
  return { key };
}

function gitWriteProbe(repository) {
  const root = mkdtempSync(join(tmpdir(), 'm5b-scope-'));
  const identity = matrixIdentity();
  try {
    chmodSync(root, 0o700);
    if (process.getuid() === 0 && identity) chownSync(root, identity.uid, identity.gid);
    const init = runAsMatrix(['git', 'init', '-q', root]);
    if (init.status !== 0) return { kind: 'exec-error', detail: firstLine(init.stderr) };
    runAsMatrix(['git', '-C', root, 'config', 'user.name', 'M5B Scope Probe']);
    runAsMatrix(['git', '-C', root, 'config', 'user.email', 'scope-probe@example.invalid']);
    const commit = runAsMatrix([
      'git',
      '-C',
      root,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'scope probe',
    ]);
    if (commit.status !== 0) return { kind: 'exec-error', detail: firstLine(commit.stderr) };
    const result = runAsMatrix([
      'git',
      '-C',
      root,
      'push',
      '--dry-run',
      `ssh://git@ssh.github.com:443/${repository}.git`,
      `HEAD:refs/heads/m5b-scope-${Date.now()}`,
    ]);
    return { kind: classify(result), detail: firstLine(result.stderr || result.stdout) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ghApi(repository, args) {
  return runAsMatrix([
    'env',
    `HOME=${matrixHome}`,
    `GH_CONFIG_DIR=${ghConfigDir}`,
    'gh',
    'api',
    ...args,
  ]);
}

function ghReadLines(repository, path, jq) {
  const result = ghApi(repository, [`repos/${repository}${path}`, '--jq', jq]);
  if (result.status !== 0) return { kind: classifyRead(result).kind, lines: [] };
  return { kind: 'allowed', lines: (result.stdout ?? '').split('\n').filter(Boolean) };
}

function ghReadRepository(repository) {
  const view = ghApi(repository, [`repos/${repository}`, '--jq', '.default_branch']);
  const viewClass = classifyRead(view);
  if (viewClass.kind !== 'allowed') {
    return {
      kind: viewClass.kind,
      stage: 'read-repo',
      detail: firstLine(view.stderr || view.stdout),
    };
  }
  return { kind: 'allowed', branch: (view.stdout ?? '').trim() || 'main' };
}

/**
 * Proves write authorization without changing remote state.
 *
 * `POST /git/refs` with a `..` ref name is rejected with 422 before anything is
 * created. The function also reads the ref/PR lists immediately before and after
 * and asserts that nothing carrying the probe nonce appeared. It never falls back
 * to a shared credential: the caller only invokes it when the dedicated gh config
 * exists.
 */
function ghRefsWriteProbe(repository, nonce) {
  const view = ghReadRepository(repository);
  if (view.kind !== 'allowed') return view;
  const ref = ghApi(repository, [
    `repos/${repository}/git/ref/heads/${view.branch}`,
    '--jq',
    '.object.sha',
  ]);
  const refClass = classifyRead(ref);
  if (refClass.kind !== 'allowed') {
    return { kind: refClass.kind, stage: 'read-head', detail: firstLine(ref.stderr || ref.stdout) };
  }
  const sha = (ref.stdout ?? '').trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    return { kind: 'failed', stage: 'read-head', detail: 'the default branch head is not a SHA' };
  }

  const pullsBefore = ghReadLines(repository, '/pulls?state=all&per_page=100', '.[].head.ref');
  const refsBefore = ghReadLines(repository, '/git/refs/heads', '.[].ref');
  if (pullsBefore.kind !== 'allowed' || refsBefore.kind !== 'allowed') {
    return {
      kind: 'failed',
      stage: 'read-side-effects-before',
      detail: `pulls=${pullsBefore.kind} refs=${refsBefore.kind}`,
    };
  }

  const probe = ghApi(repository, [
    '-X',
    'POST',
    `repos/${repository}/git/refs`,
    '-f',
    `ref=${invalidRefFor(nonce)}`,
    '-f',
    `sha=${sha}`,
  ]);
  const writeClass = classifyWrite(probe);

  const pullsAfter = ghReadLines(repository, '/pulls?state=all&per_page=100', '.[].head.ref');
  const refsAfter = ghReadLines(repository, '/git/refs/heads', '.[].ref');
  let effects = { ok: false, detail: 'side-effect read-back failed' };
  if (pullsAfter.kind === 'allowed' && refsAfter.kind === 'allowed') {
    effects = assertNoSideEffects(
      { refs: refsBefore.lines, pulls: pullsBefore.lines },
      { refs: refsAfter.lines, pulls: pullsAfter.lines },
    );
  }
  return {
    kind: writeClass.kind,
    stage: 'write',
    http: writeClass.http,
    detail: writeClass.detail ?? redact(firstLine(probe.stderr || probe.stdout)).slice(0, 140),
    effects,
  };
}

/**
 * Issues write probe: omit the required title so GitHub returns exactly
 * `"title" wasn't supplied.` after checking authorization. No issue is created.
 */
function ghIssuesWriteProbe(repository) {
  const view = ghReadRepository(repository);
  if (view.kind !== 'allowed') return view;
  const before = ghReadLines(
    repository,
    '/issues?state=all&per_page=100',
    '.[] | select(.pull_request == null) | .number',
  );
  if (before.kind !== 'allowed') {
    return { kind: 'failed', stage: 'read-issues-before', detail: 'cannot list issues' };
  }
  const probe = ghApi(repository, [
    '-X',
    'POST',
    `repos/${repository}/issues`,
    '-f',
    'body=m5b isolation scope probe',
  ]);
  const writeClass = classifyValidationWrite(probe, ISSUES_VALIDATION_MESSAGE);
  const after = ghReadLines(
    repository,
    '/issues?state=all&per_page=100',
    '.[] | select(.pull_request == null) | .number',
  );
  const effects =
    after.kind === 'allowed'
      ? assertListUnchanged(before.lines, after.lines, 'issue')
      : { ok: false, detail: 'side-effect read-back failed' };
  return {
    kind: writeClass.kind,
    stage: 'write',
    http: writeClass.http,
    detail: writeClass.detail ?? redact(firstLine(probe.stderr || probe.stdout)).slice(0, 140),
    effects,
  };
}

/**
 * Pull-request write probe: omit head and base so GitHub returns exactly
 * `"base", "head" weren't supplied.` after checking authorization. No PR is
 * created and no branch is touched.
 */
function ghPullsWriteProbe(repository) {
  const view = ghReadRepository(repository);
  if (view.kind !== 'allowed') return view;
  const before = ghReadLines(repository, '/pulls?state=all&per_page=100', '.[].number');
  if (before.kind !== 'allowed') {
    return { kind: 'failed', stage: 'read-pulls-before', detail: 'cannot list pull requests' };
  }
  const probe = ghApi(repository, [
    '-X',
    'POST',
    `repos/${repository}/pulls`,
    '-f',
    'body=m5b isolation scope probe',
  ]);
  const writeClass = classifyValidationWrite(probe, PULLS_VALIDATION_MESSAGE);
  const after = ghReadLines(repository, '/pulls?state=all&per_page=100', '.[].number');
  const effects =
    after.kind === 'allowed'
      ? assertListUnchanged(before.lines, after.lines, 'pull request')
      : { ok: false, detail: 'side-effect read-back failed' };
  return {
    kind: writeClass.kind,
    stage: 'write',
    http: writeClass.http,
    detail: writeClass.detail ?? redact(firstLine(probe.stderr || probe.stdout)).slice(0, 140),
    effects,
  };
}

function scopeStatus(kind, mustBeDenied = false) {
  if (mustBeDenied) return kind === 'denied' ? 'PASS' : kind === 'allowed' ? 'FAIL' : 'INCOMPLETE';
  if (kind === 'allowed') return 'PASS';
  if (kind === 'denied' || kind === 'unexpected-success') return 'FAIL';
  return 'INCOMPLETE';
}

function recordGhProbe(repository, name, probe, mustBeDenied) {
  const suffix = mustBeDenied ? ' (must be denied)' : '';
  record(
    'scope',
    `gh-${name}-write:${repository}${suffix}`,
    scopeStatus(probe.kind, mustBeDenied),
    `${probe.kind} (stage=${probe.stage}${probe.http ? ` http=${probe.http}` : ''}) — ${probe.detail}`,
  );
  record(
    'scope',
    `gh-${name}-side-effects:${repository}${suffix}`,
    probe.effects ? (probe.effects.ok ? 'PASS' : 'FAIL') : mustBeDenied ? 'SKIP' : 'INCOMPLETE',
    probe.effects
      ? probe.effects.detail
      : mustBeDenied
        ? 'read denied; no write was attempted'
        : 'side-effect read-back unavailable',
  );
}

function scopeProbes(identity) {
  if (!online) {
    record('scope', 'online-probes', 'SKIP', 'run with --online to check repository reach');
    return;
  }
  if (!identity) {
    record('scope', 'online-probes', 'INCOMPLETE', 'identity does not exist');
    return;
  }
  const sshInstalled =
    existsSync(sshKey) &&
    existsSync(join(matrixHome, '.ssh', 'probe_deploy')) &&
    existsSync(join(matrixHome, '.ssh', 'config'));
  const ghConfigured = existsSync(join(ghConfigDir, 'hosts.yml'));
  if (!sshInstalled) {
    record('scope', 'ssh-scope', 'INCOMPLETE', 'the dedicated probe key is not installed');
  }
  if (!ghConfigured) {
    record(
      'scope',
      'gh-scope',
      'INCOMPLETE',
      `the dedicated gh configuration is missing: ${ghConfigDir} (shared credentials are never used)`,
    );
  }

  for (const repository of probeRepositories) {
    if (sshInstalled) {
      const git = gitWriteProbe(repository);
      record(
        'scope',
        `git-push-dry-run:${repository}`,
        git.kind === 'allowed' ? 'PASS' : git.kind === 'denied' ? 'FAIL' : 'INCOMPLETE',
        `${git.kind} — ${git.detail}`,
      );
    } else {
      record('scope', `git-push-dry-run:${repository}`, 'INCOMPLETE', 'no dedicated key');
    }
    if (ghConfigured) {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      recordGhProbe(repository, 'refs', ghRefsWriteProbe(repository, nonce), false);
      recordGhProbe(repository, 'issues', ghIssuesWriteProbe(repository), false);
      recordGhProbe(repository, 'pulls', ghPullsWriteProbe(repository), false);
    } else {
      for (const name of ['refs', 'issues', 'pulls']) {
        record(
          'scope',
          `gh-${name}-write:${repository}`,
          'INCOMPLETE',
          'no dedicated gh credential',
        );
      }
    }
  }

  if (sshInstalled) {
    const forbiddenGit = gitWriteProbe(forbiddenRepository);
    record(
      'scope',
      `git-push-dry-run:${forbiddenRepository} (must be denied)`,
      scopeStatus(forbiddenGit.kind, true),
      `${forbiddenGit.kind} — ${forbiddenGit.detail}`,
    );
  }
  if (ghConfigured) {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    recordGhProbe(forbiddenRepository, 'refs', ghRefsWriteProbe(forbiddenRepository, nonce), true);
    recordGhProbe(forbiddenRepository, 'issues', ghIssuesWriteProbe(forbiddenRepository), true);
    recordGhProbe(forbiddenRepository, 'pulls', ghPullsWriteProbe(forbiddenRepository), true);
  }
}

function layoutAudit(identity) {
  const facts = describePath(layout.run);
  record(
    'run-layout',
    layout.run,
    facts.exists && facts.uid === 0 ? 'PASS' : 'FAIL',
    `owner=${facts.uid ?? 'missing'} mode=${facts.mode ?? 'missing'}`,
  );
  for (const entry of [
    { name: 'protected', path: layout.protectedDir },
    { name: 'config', path: layout.configDir },
  ]) {
    const dir = describePath(entry.path);
    record(
      'run-layout',
      entry.name,
      dir.exists ? 'PASS' : 'INCOMPLETE',
      dir.exists ? `owner=${dir.uid} mode=${dir.mode}` : 'absent (created by stack.sh)',
    );
  }
  for (const name of ['supervisor-token', 'seed.env', 'state.env']) {
    const file = describePath(join(layout.run, name));
    record(
      'run-layout',
      `legacy-secret:${name}`,
      file.exists ? 'FAIL' : 'PASS',
      file.exists
        ? `owner=${file.uid} mode=${file.mode} outside the protected directory`
        : 'absent',
    );
  }
  let credentialCount = 0;
  if (existsSync(layout.credentialsDir)) {
    try {
      credentialCount = readdirSync(layout.credentialsDir).filter((entry) =>
        statSync(join(layout.credentialsDir, entry)).isFile(),
      ).length;
    } catch {
      credentialCount = -1;
    }
  }
  record(
    'run-layout',
    'bridge-credentials',
    credentialCount > 0 ? 'FAIL' : 'PASS',
    credentialCount > 0
      ? `${credentialCount} stale bridge credential file(s) from earlier runs`
      : 'none',
  );
  const dshHome = describePath(layout.dshHome);
  record(
    'run-layout',
    'dsh-home',
    !dshHome.exists || dshHome.uid === identity?.uid ? 'PASS' : 'FAIL',
    dshHome.exists ? `owner=${dshHome.uid} mode=${dshHome.mode}` : 'absent',
  );
}

const startedAt = new Date().toISOString();
const identity = matrixIdentity();
if (identity) {
  record(
    'identity',
    userName,
    'PASS',
    `uid=${identity.uid} gid=${identity.gid} groups=${identity.gids.join(',')}`,
  );
} else {
  record(
    'identity',
    userName,
    'INCOMPLETE',
    'identity does not exist; run prepare-nonroot.sh --apply',
  );
}
const host = gate ? null : hostAudit(identity);
const credentials = identity ? credentialAudit(identity) : null;
scopeProbes(identity);
if (!gate) layoutAudit(identity);

const summary = {
  recorded: startedAt,
  mode: gate ? 'gate' : online ? 'online' : 'local',
  host,
  identity,
  credentials,
  sshKey,
  ghConfigDir,
  probeRepositories,
  checks,
  findings,
  incomplete,
  verdict: findings.length > 0 ? 'violated' : incomplete.length > 0 ? 'incomplete' : 'clean',
};

if (json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  console.log('# M5-B matrix isolation precheck');
  console.log(`recorded=${startedAt}`);
  console.log(`host=${hostname()} user=${userName} mode=${summary.mode}`);
  console.log(`matrix_home=${matrixHome}`);
  console.log(`ssh_key=${sshKey}`);
  console.log(`gh_config=${ghConfigDir}`);
  console.log(`run_root=${layout.run}`);
  console.log(`probe_repositories=${probeRepositories.join(',')}`);
  console.log(`forbidden_repository=${forbiddenRepository}`);
  console.log('');
  let section = '';
  for (const entry of checks) {
    if (entry.section !== section) {
      section = entry.section;
      console.log(`## ${section}`);
    }
    console.log(`  ${entry.status.padEnd(10)} ${entry.name} — ${entry.detail}`);
  }
  console.log('');
  if (findings.length > 0) {
    console.log('verdict=violated');
    for (const finding of findings) {
      console.log(`  - ${finding.section}/${finding.name}: ${finding.detail}`);
    }
  } else if (incomplete.length > 0) {
    console.log('verdict=incomplete');
    for (const entry of incomplete)
      console.log(`  - ${entry.section}/${entry.name}: ${entry.detail}`);
  } else {
    console.log('verdict=clean');
  }
}

if (summary.verdict === 'violated') process.exitCode = 1;
else if (summary.verdict === 'incomplete') process.exitCode = gate ? 1 : 2;
