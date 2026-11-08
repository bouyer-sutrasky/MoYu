#!/usr/bin/env node
/**
 * Read-only isolation precheck for the M5-B on-site matrix.
 *
 * Answers the questions the ticket asks before any matrix rerun:
 *
 *   - can the dedicated test identity write host configuration (bootstrap DSH
 *     homes, shared gh configuration, SSH keys)?  (must be no)
 *   - can it read a shared credential?                          (must be no)
 *   - are its own credentials dedicated to the probe repositories and does it
 *     really reach only those?                     (checked with --online)
 *   - do privileged bootstrap files live outside the matrix-writable tree, and
 *     is there stale privileged state from an earlier layout?
 *
 * The script never writes: it stats paths, calls the guard's pure audits, and
 * (with --online) performs GET/`git ls-remote` probes as the test identity. It
 * prints no file content and no token: only modes, owners and pass/fail.
 *
 *   node scripts/m5b/matrix/precheck.mjs                 # local facts
 *   node scripts/m5b/matrix/precheck.mjs --online        # plus credential scope
 *   node scripts/m5b/matrix/precheck.mjs --json          # machine readable
 *
 * Exit codes: 0 clean, 1 isolation violation, 2 evidence incomplete (missing
 * dedicated credential or a host probe that could not run).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  return process.env[`M5B_MATRIX_${name.toUpperCase().replaceAll('-', '_')}`] ?? fallback;
};

const json = flags.has('--json');
const online = flags.has('--online');
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

function asMatrix(args, options = {}) {
  return spawnSync('runuser', ['-u', userName, '--', ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 20000,
  });
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
      observed = asMatrix(['test', '-w', path]).status === 0 ? 'writable' : 'not-writable';
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
      observed = asMatrix(['test', '-r', path]).status === 0 ? 'readable' : 'not-readable';
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
    key = assertDedicatedSshKey({
      keyPath: sshKey,
      hostKeyDir: '/root/.ssh',
      uid: identity.uid,
    });
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
    record('credentials', `gh-config:${config.path}`, 'PASS', 'token=present (not printed)');
  } catch (error) {
    const missing = /does not exist/.test(error.message);
    record(
      'credentials',
      `gh-config:${ghConfigDir}`,
      missing ? 'INCOMPLETE' : error instanceof IsolationGuardError ? 'FAIL' : 'INCOMPLETE',
      redact(error.message),
    );
  }
  return { key };
}

function scopeProbes() {
  if (!online) {
    record('scope', 'online-probes', 'SKIP', 'run with --online to check repository reach');
    return;
  }
  const check = (label, args, expectedOk) => {
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 30000 });
    const ok = result.status === 0;
    const pass = expectedOk ? ok : !ok;
    const detail = ok
      ? 'reachable'
      : `denied (${(result.stderr || result.stdout || '').split('\n')[0].slice(0, 120)})`;
    record('scope', label, pass ? 'PASS' : 'FAIL', redact(detail));
  };
  for (const repository of probeRepositories) {
    check(
      `git:${repository}`,
      [
        '-u',
        userName,
        '--',
        'env',
        `HOME=${matrixHome}`,
        'git',
        'ls-remote',
        '--heads',
        `ssh://git@ssh.github.com:443/${repository}.git`,
      ],
      true,
    );
  }
  check(
    `git:${forbiddenRepository} (must be denied)`,
    'runuser',
    [
      '-u',
      userName,
      '--',
      'env',
      `HOME=${matrixHome}`,
      'git',
      'ls-remote',
      '--heads',
      `ssh://git@ssh.github.com:443/${forbiddenRepository}.git`,
    ],
    false,
  );
  for (const repository of probeRepositories) {
    check(
      `gh:${repository}`,
      [
        '-u',
        userName,
        '--',
        'env',
        `HOME=${matrixHome}`,
        `GH_CONFIG_DIR=${ghConfigDir}`,
        'gh',
        'api',
        `repos/${repository}`,
        '--jq',
        '.full_name',
      ],
      true,
    );
  }
  check(
    `gh:${forbiddenRepository} (must be denied)`,
    'runuser',
    [
      '-u',
      userName,
      '--',
      'env',
      `HOME=${matrixHome}`,
      `GH_CONFIG_DIR=${ghConfigDir}`,
      'gh',
      'api',
      `repos/${forbiddenRepository}`,
      '--jq',
      '.full_name',
    ],
    false,
  );
}

function layoutAudit(identity) {
  const facts = describePath(layout.run);
  record(
    'run-layout',
    layout.run,
    facts.exists && facts.uid === 0 ? 'PASS' : 'FAIL',
    `owner=${facts.uid ?? 'missing'} mode=${facts.mode ?? 'missing'}`,
  );
  const privileged = [
    { name: 'protected', path: layout.protectedDir, wantPrivate: true },
    { name: 'config', path: layout.configDir, wantPrivate: false },
  ];
  for (const entry of privileged) {
    const dir = describePath(entry.path);
    record(
      'run-layout',
      entry.name,
      dir.exists ? 'PASS' : 'INCOMPLETE',
      dir.exists ? `owner=${dir.uid} mode=${dir.mode}` : 'absent (created by stack.sh)',
    );
  }
  // The pre-guard layout wrote privileged files into the matrix-owned run root.
  const legacySecrets = ['supervisor-token', 'seed.env', 'state.env'];
  for (const name of legacySecrets) {
    const path = join(layout.run, name);
    const file = describePath(path);
    record(
      'run-layout',
      `legacy-secret:${name}`,
      file.exists ? 'FAIL' : 'PASS',
      file.exists
        ? `owner=${file.uid} mode=${file.mode} outside the protected directory`
        : 'absent',
    );
  }
  const credentialsDir = layout.credentialsDir;
  let credentialCount = 0;
  if (existsSync(credentialsDir)) {
    try {
      credentialCount = readdirSync(credentialsDir).filter((entry) =>
        statSync(join(credentialsDir, entry)).isFile(),
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
const host = hostAudit(identity);
const credentials = identity ? credentialAudit(identity) : null;
scopeProbes();
layoutAudit(identity);

const summary = {
  recorded: startedAt,
  host,
  credentials,
  user: userName,
  identity,
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
  console.log(`host=${hostname()} user=${userName}`);
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
    console.log('findings:');
    for (const finding of findings)
      console.log(`  - ${finding.section}/${finding.name}: ${finding.detail}`);
  } else if (incomplete.length > 0) {
    console.log('verdict=incomplete');
    for (const entry of incomplete)
      console.log(`  - ${entry.section}/${entry.name}: ${entry.detail}`);
  } else {
    console.log('verdict=clean');
  }
}

if (summary.verdict === 'violated') process.exitCode = 1;
else if (summary.verdict === 'incomplete') process.exitCode = 2;
