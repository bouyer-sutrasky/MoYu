import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';

const scriptPath = fileURLToPath(new URL('../verify-lock.sh', import.meta.url));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function listFiles(root, dir = root) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  return files;
}

function sortPaths(paths) {
  return paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

// Mirrors the manifest in verify-lock.sh: sorted sha256sum lines with the
// "./" (or "lib/") prefix removed, hashed again.
function manifest(root, { excluded = [], stripPrefix = './' } = {}) {
  const lines = sortPaths(listFiles(root))
    .map((file) => `${stripPrefix}${file}`)
    .filter((path) => !excluded.some((prefix) => path.startsWith(prefix)))
    .map((path) => `${sha256(readFileSync(join(root, path)))}  ${path.slice(stripPrefix.length)}`);
  return sha256(lines.map((line) => `${line}\n`).join(''));
}

function writeFixture(root) {
  const dsh = join(root, 'dsh');
  const superagent = join(root, 'superagent');
  const files = {
    [join(dsh, 'package.json')]: JSON.stringify({ name: 'fixture-harness', version: '0.0.0' }),
    [join(dsh, 'lib', 'bin.js')]: 'console.log("harness fixture");\n',
    [join(dsh, 'lib', 'extra.js')]: 'export const value = 1;\n',
    [join(dsh, 'node_modules', 'noise.js')]: 'excluded from the manifest\n',
    [join(superagent, 'package.json')]: JSON.stringify({
      name: 'fixture-superagent',
      version: '1.0.0',
    }),
    [join(superagent, 'src', 'index.js')]: 'export const fixture = true;\n',
    [join(superagent, 'lib', 'index.js')]: 'export const built = true;\n',
    [join(superagent, 'node_modules', 'noise.js')]: 'excluded from the manifest\n',
    [join(superagent, '.artifacts', 'noise.js')]: 'excluded from the manifest\n',
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, contents);
  }
  const dshTarball = join(root, 'dsh.tgz');
  const superagentTarball = join(root, 'superagent.tar.gz');
  writeFileSync(dshTarball, 'fixture dsh tarball\n');
  writeFileSync(superagentTarball, 'fixture superagent tarball\n');
  return { dsh, superagent, dshTarball, superagentTarball };
}

function buildLock({ dsh, superagent, dshTarball, superagentTarball }) {
  const harnessManifest = manifest(dsh, { excluded: ['./node_modules/'] });
  const superagentManifest = manifest(superagent, {
    excluded: ['./node_modules/', './lib/', './.artifacts/'],
  });
  return {
    harness: {
      version: '0.0.0',
      npm: { sha256: sha256(readFileSync(dshTarball)) },
      install: {
        entrySha256: sha256(readFileSync(join(dsh, 'lib', 'bin.js'))),
        packageFiles: listFiles(dsh).filter((file) => !file.startsWith('node_modules/')).length,
        packageFilesManifestSha256: harnessManifest,
      },
    },
    superagent: {
      version: '1.0.0',
      tarball: { sha256: sha256(readFileSync(superagentTarball)) },
      install: {
        sourceFiles: listFiles(superagent).filter(
          (file) =>
            !file.startsWith('node_modules/') &&
            !file.startsWith('lib/') &&
            !file.startsWith('.artifacts/'),
        ).length,
        sourceFilesManifestSha256: superagentManifest,
        libFiles: listFiles(join(superagent, 'lib')).length,
        libFilesManifestSha256: manifest(join(superagent, 'lib'), { stripPrefix: '' }),
      },
    },
  };
}

function runChecker(checker, dirs) {
  return spawnSync('bash', [join(checker, 'verify-lock.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LC_ALL: 'C',
      DSH_DIR: dirs.dsh,
      SUPERAGENT_DIR: dirs.superagent,
      DSH_TARBALL: dirs.dshTarball,
      SUPERAGENT_TARBALL: dirs.superagentTarball,
    },
  });
}

test('verify-lock.sh gives the same result for plain, spaced and quoted paths', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'moyu-verify-lock-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const checker = join(base, 'checker');
  mkdirSync(checker);
  cpSync(scriptPath, join(checker, 'verify-lock.sh'));

  const fixture = writeFixture(join(base, 'fixture'));
  writeFileSync(join(checker, 'upstream.lock.json'), JSON.stringify(buildLock(fixture), null, 2));

  const cases = [
    { label: 'plain path', dirname: 'repo' },
    { label: 'path with spaces', dirname: 'repo with spaces' },
    { label: 'path with a single quote', dirname: "repo's copy" },
  ].map(({ label, dirname }) => {
    const root = join(base, 'cases', dirname);
    mkdirSync(join(base, 'cases'), { recursive: true });
    cpSync(join(base, 'fixture'), root, { recursive: true });
    return {
      label,
      dirs: {
        dsh: join(root, 'dsh'),
        superagent: join(root, 'superagent'),
        dshTarball: join(root, 'dsh.tgz'),
        superagentTarball: join(root, 'superagent.tar.gz'),
      },
    };
  });

  let plainStdout;
  for (const { label, dirs } of cases) {
    const result = runChecker(checker, dirs);
    assert.equal(
      result.status,
      0,
      `${label}: expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /baseline ok: installed artifacts match/);
    assert.equal(result.stderr, '', `${label}: expected no stderr`);
    if (plainStdout === undefined) {
      plainStdout = result.stdout;
    } else {
      assert.equal(result.stdout, plainStdout, `${label}: expected the plain-path result`);
    }
  }

  const quoted = cases.at(-1);
  const tamper = (file, contents, expectedFailure) => {
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original + contents);
    const result = runChecker(checker, quoted.dirs);
    assert.equal(result.status, 1, `${expectedFailure}: expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes(expectedFailure),
      `${expectedFailure}: missing from stderr\n${result.stderr}`,
    );
    assert.match(result.stderr, /baseline mismatch: installed artifacts differ/);
    writeFileSync(file, original);
  };

  tamper(
    join(quoted.dirs.dsh, 'lib', 'extra.js'),
    '// tampered\n',
    'FAIL Harness package files manifest',
  );
  tamper(
    join(quoted.dirs.superagent, 'src', 'index.js'),
    '// tampered\n',
    'FAIL superagent source manifest',
  );
  const tarball = quoted.dirs.superagentTarball;
  const originalTarball = readFileSync(tarball);
  writeFileSync(tarball, Buffer.concat([originalTarball, Buffer.from('tampered')]));
  const tarballResult = runChecker(checker, quoted.dirs);
  assert.equal(tarballResult.status, 1);
  assert.match(tarballResult.stderr, /FAIL superagent tarball sha256/);
  writeFileSync(tarball, originalTarball);

  const restored = runChecker(checker, quoted.dirs);
  assert.equal(restored.status, 0, `restored fixture: ${restored.stderr}`);
});
