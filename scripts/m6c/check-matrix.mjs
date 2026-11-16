#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  assertAllowedPath,
  fail,
  parseArgs,
  printHelpAndExit,
  readJson,
  sha256File,
} from './lib.mjs';

const HELP = [
  '--matrix <file>          JSON matrix with rows [{ id, status, evidence, ... }] (required)',
  '--evidence <dir>         evidence root for relative paths (required)',
  '--allow-incomplete       report incomplete rows but exit 0 (diagnostics only)',
  '--help                   show this help without reading the matrix',
];

const { values } = parseArgs(process.argv.slice(2));
if (values.help) {
  printHelpAndExit('Check that every M6-C acceptance row has real evidence', HELP, [
    'node scripts/m6c/check-matrix.mjs --matrix docs/evidence/m6c/RUN/matrix.json --evidence docs/evidence/m6c/RUN',
  ]);
}
if (!values.matrix) fail('check-matrix: --matrix is required', 2);
if (!values.evidence) fail('check-matrix: --evidence is required', 2);
const matrixPath = assertAllowedPath(resolve(String(values.matrix)), 'matrix');
const evidenceDir = assertAllowedPath(resolve(String(values.evidence)), 'evidence root');
const parsed = readJson(matrixPath);
const rows = Array.isArray(parsed) ? parsed : parsed.rows;
if (!Array.isArray(rows) || rows.length === 0) {
  fail('check-matrix: matrix has no rows', 1);
}

const PASS = new Set(['pass', 'passed']);
const failures = [];
for (const row of rows) {
  const id = String(row.id ?? '(missing id)');
  const status = String(row.status ?? 'Not run');
  if (!PASS.has(status.toLowerCase())) {
    failures.push(`${id}: status ${status}`);
    continue;
  }
  if (!row.environment || !row.sha || !row.command || row.exitCode === undefined) {
    failures.push(`${id}: missing environment/sha/command/exitCode evidence fields`);
    continue;
  }
  if (!row.evidence) {
    failures.push(`${id}: no evidence path`);
    continue;
  }
  const evidencePath = isAbsolute(row.evidence) ? row.evidence : join(evidenceDir, row.evidence);
  const safe = assertAllowedPath(evidencePath, `${id} evidence`);
  if (!existsSync(safe) || statSync(safe).size === 0) {
    failures.push(`${id}: evidence is missing or empty (${safe})`);
    continue;
  }
  if (row.artifactSha256 && sha256File(safe) !== row.artifactSha256) {
    failures.push(`${id}: evidence hash does not match artifactSha256`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`check-matrix: ${failures.length} incomplete row(s)\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(values['allow-incomplete'] === true ? 0 : 1);
}
process.stdout.write(
  `${JSON.stringify({ rows: rows.length, passed: rows.length, evidenceRoot: evidenceDir })}\n`,
);
