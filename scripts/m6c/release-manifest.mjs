#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  assertAllowedPath,
  fileInfo,
  findFiles,
  parseArgs,
  printHelpAndExit,
  readJson,
  run,
  sha256File,
  sha256Text,
  writeJson,
} from './lib.mjs';

const HELP = [
  '--source <dir>           clean Git worktree to describe (default: .)',
  '--out <file>             manifest JSON path (required)',
  '--plugin-dir <dir>       built dsh-superagent artifact directory (required for a release)',
  '--units-dir <dir>        systemd templates (default: <source>/deploy/systemd)',
  '--allow-dirty            record a dirty manifest for diagnostics only',
  '--allow-missing-plugin   diagnostics only; the release gate rejects it',
  '--help                   show this help without touching the filesystem',
];

const { values } = parseArgs(process.argv.slice(2));
if (values.help)
  printHelpAndExit('Build a MoYu M6-C immutable release manifest', HELP, [
    'node scripts/m6c/release-manifest.mjs --source . --out docs/evidence/m6c/RUN/release-manifest.json --plugin-dir /opt/moyu-m6c/artifacts/superagent-<sha>',
  ]);

if (!values.out) {
  process.stderr.write('release-manifest: --out is required\n');
  process.exit(2);
}
const source = assertAllowedPath(resolve(String(values.source ?? '.')), 'source');
const out = resolve(String(values.out));
const unitsDir = assertAllowedPath(
  resolve(String(values.unitsDir ?? join(source, 'deploy/systemd'))),
  'units directory',
);
const pluginDir = values['plugin-dir']
  ? assertAllowedPath(resolve(String(values['plugin-dir'])), 'plugin directory')
  : null;
if (!pluginDir && values['allow-missing-plugin'] !== true) {
  process.stderr.write(
    'release-manifest: --plugin-dir is required; use --allow-missing-plugin only for diagnostics\n',
  );
  process.exit(2);
}

const git = (...args) => run('git', ['-C', source, ...args]).stdout.trim();
const status = git('status', '--porcelain=v1', '--untracked-files=no');
const sourceSha = git('rev-parse', 'HEAD');
const sourceTree = git('rev-parse', 'HEAD^{tree}');
const dirty = status.length > 0;
if (dirty && values['allow-dirty'] !== true) {
  process.stderr.write(
    `release-manifest: source is dirty; commit the tree first (or pass --allow-dirty for diagnostics)\n${status}\n`,
  );
  process.exit(1);
}

const artifactPaths = [
  'apps/api/dist/server.js',
  'apps/supervisor/dist/main.js',
  'apps/dispatcher/dist/main.js',
  'apps/web/dist/index.html',
];
const artifacts = {};
for (const relativePath of artifactPaths) {
  const path = join(source, relativePath);
  if (!existsSync(path)) {
    process.stderr.write(
      `release-manifest: missing built artifact ${relativePath}; run pnpm build\n`,
    );
    process.exit(1);
  }
  artifacts[relativePath] = fileInfo(path).sha256;
}
const webAssets = findFiles(join(source, 'apps/web/dist'), (path) => /\.(js|css)$/.test(path), 100)
  .map((path) => ({
    path: path.slice(source.length + 1),
    sha256: sha256File(path),
  }))
  .sort((left, right) => left.path.localeCompare(right.path));

const journal = readJson(join(source, 'packages/db/migrations/meta/_journal.json'));
const migrations = journal.entries.map((entry) => entry.tag);
const lock = join(source, 'integrations/superagent/upstream.lock.json');
if (!existsSync(lock)) {
  process.stderr.write('release-manifest: integrations/superagent/upstream.lock.json is missing\n');
  process.exit(1);
}

let plugin = null;
if (pluginDir) {
  const entry = join(pluginDir, 'lib/index.js');
  if (!existsSync(entry)) {
    process.stderr.write(`release-manifest: plugin artifact has no lib/index.js: ${pluginDir}\n`);
    process.exit(1);
  }
  plugin = {
    directory: pluginDir,
    entry: fileInfo(entry).path,
    entrySha256: sha256File(entry),
    files: findFiles(pluginDir, () => true, 500)
      .map((path) => ({ path: path.slice(pluginDir.length + 1), sha256: sha256File(path) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

const units = existsSync(unitsDir)
  ? readdirSync(unitsDir)
      .filter((name) => /^moyu-m6c-.*\.(service|slice)$/.test(name))
      .sort()
      .map((name) => ({ name, sha256: sha256File(join(unitsDir, name)) }))
  : [];
if (units.length < 4) {
  process.stderr.write(
    `release-manifest: expected at least four moyu-m6c service/slice templates in ${unitsDir}, found ${units.length}\n`,
  );
  process.exit(1);
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    directory: source,
    gitHead: sourceSha,
    gitTree: sourceTree,
    dirty,
    status,
  },
  toolchain: {
    node: run('node', ['--version']).stdout.trim(),
    pnpm: run('pnpm', ['--version']).stdout.trim(),
  },
  artifacts,
  webAssets,
  plugin,
  migrations: {
    count: migrations.length,
    last: migrations.at(-1) ?? null,
    journalSha256: sha256File(join(source, 'packages/db/migrations/meta/_journal.json')),
  },
  upstreamLock: {
    path: lock,
    sha256: sha256File(lock),
    package: readJson(lock).harness?.package ?? null,
    version: readJson(lock).harness?.version ?? null,
    superagentCommit: readJson(lock).superagent?.upstream?.commit ?? null,
  },
  units,
  unitSummarySha256: sha256Text(units.map((unit) => `${unit.name}:${unit.sha256}`).join('\n')),
};

writeJson(out, manifest);
process.stdout.write(
  `${JSON.stringify({
    out,
    gitHead: sourceSha,
    dirty,
    artifacts: Object.keys(artifacts).length,
    migrations: migrations.length,
    pluginEntrySha256: plugin?.entrySha256 ?? null,
    units: units.length,
  })}\n`,
);
