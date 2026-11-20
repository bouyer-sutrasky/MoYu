import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { URL, fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('./lib.sh', import.meta.url));
const DEFAULT_CONTROL = 'Bouyer12/m5a-epsilon-adf10ad9';

function controlValue(env) {
  const result = spawnSync(
    'bash',
    ['-c', 'source "$1"; printf %s "$M5B_MATRIX_CONTROL_REPOSITORY"', 'bash', LIB],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('the control repository defaults only when the variable is unset', () => {
  const unset = { ...process.env };
  delete unset.M5B_MATRIX_CONTROL_REPOSITORY;
  assert.equal(controlValue(unset), DEFAULT_CONTROL);

  // An explicitly empty value must survive lib.sh so the startup gate rejects
  // it; `${VAR:-default}` would silently replace it with the default.
  assert.equal(controlValue({ ...process.env, M5B_MATRIX_CONTROL_REPOSITORY: '' }), '');

  assert.equal(
    controlValue({ ...process.env, M5B_MATRIX_CONTROL_REPOSITORY: 'owner/control' }),
    'owner/control',
  );
});
