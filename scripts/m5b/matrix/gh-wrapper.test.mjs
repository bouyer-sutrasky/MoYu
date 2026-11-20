import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('./gh-m5b.sh', import.meta.url));

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'm5b-gh-'));
}

test('the matrix gh wrapper pins the dedicated config and drops token env overrides', () => {
  const root = sandbox();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'cfg'));
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'printf "home=%s\\n" "$HOME"',
      'printf "config=%s\\n" "$GH_CONFIG_DIR"',
      'printf "token=%s\\n" "${GH_TOKEN-unset}"',
      'printf "github_token=%s\\n" "${GITHUB_TOKEN-unset}"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync('/bin/sh', [WRAPPER, 'auth', 'status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      M5B_MATRIX_GH_HOME: join(root, 'home'),
      M5B_MATRIX_GH_CONFIG_DIR: join(root, 'cfg'),
      GH_TOKEN: 'shared-token-must-not-leak',
      GITHUB_TOKEN: 'shared-token-must-not-leak',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`home=${root}/home`));
  assert.match(result.stdout, new RegExp(`config=${root}/cfg`));
  assert.match(result.stdout, /token=unset/);
  assert.match(result.stdout, /github_token=unset/);
  assert.equal(result.stdout.includes('shared-token-must-not-leak'), false);
  rmSync(root, { recursive: true, force: true });
});
