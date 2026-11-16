import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_ALLOWED_ROOTS = [
  '/opt/moyu-m6c',
  '/var/lib/moyu-m6c',
  '/etc/moyu-m6c',
  '/root/m6c-backups',
  '/root/src/moyu-m6c-exec-20261116',
];

export function parseArgs(argv, options = {}) {
  const values = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      values.help = true;
      continue;
    }
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (inline !== undefined) {
      values[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = true;
    }
  }
  if (options.required) {
    for (const key of options.required) {
      if (values[key] === undefined || values[key] === '') {
        throw new Error(`missing required --${key}`);
      }
    }
  }
  return { values, positional };
}

export function usage(title, lines, examples = []) {
  const text = [
    title,
    '',
    'Options:',
    ...lines.map((line) => `  ${line}`),
    ...(examples.length > 0 ? ['', 'Examples:', ...examples.map((line) => `  ${line}`)] : []),
    '',
    'This command is side-effect free when invoked with --help.',
  ].join('\n');
  return `${text}\n`;
}

export function printHelpAndExit(title, lines, examples = []) {
  process.stdout.write(usage(title, lines, examples));
  process.exit(0);
}

export function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

export function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function allowedRoots() {
  const configured = process.env.M6C_ALLOWED_ROOTS;
  return (configured ? configured.split(':') : DEFAULT_ALLOWED_ROOTS)
    .filter(Boolean)
    .map((root) => resolve(root));
}

export function assertAllowedPath(path, label = 'path') {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path: ${String(path)}`);
  }
  const resolved = resolve(path);
  if (resolved === '/' || resolved === '/root' || resolved === '/home') {
    throw new Error(`${label} must not be a broad system path: ${resolved}`);
  }
  const roots = allowedRoots();
  const inside = roots.some((root) => {
    const rel = relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!inside) {
    throw new Error(
      `${label} ${resolved} is outside M6C_ALLOWED_ROOTS (${roots.join(', ')}); refusing to continue`,
    );
  }
  const real = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const realInside = roots.some((root) => {
    const base = existsSync(root) ? realpathSync(root) : root;
    const rel = relative(base, real);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!realInside) {
    throw new Error(`${label} resolves outside M6C_ALLOWED_ROOTS: ${real}`);
  }
  return real;
}

export function assertDatabaseTarget(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`unsupported database protocol ${parsed.protocol}`);
  }
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) throw new Error('DATABASE_URL has no database name');
  if (/prod/i.test(name) && !options.allowProduction) {
    throw new Error(`refusing database ${name}: production-shaped names need --allow-production`);
  }
  return { url, database: name, host: parsed.hostname, port: parsed.port || '5432' };
}

export function redact(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, 'postgresql://[REDACTED]')
    .replace(/(DATABASE_URL=)[^\s]+/g, '$1[REDACTED]');
}

export function run(command, args, options = {}) {
  const rendered = [command, ...args].join(' ');
  const safe = redact(rendered);
  if (!options.quiet) process.stderr.write(`+ ${safe}\n`);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = redact(`${result.stderr ?? ''}${result.stdout ?? ''}`)
      .trim()
      .slice(-2000);
    throw new Error(`command failed (exit ${result.status ?? 'unknown'}): ${safe}\n${detail}`);
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    command: safe,
  };
}

export function ensureDir(path, mode = 0o700) {
  const allowed = assertAllowedPath(path, 'directory');
  mkdirSync(allowed, { recursive: true, mode });
  return allowed;
}

export function fileInfo(path) {
  const allowed = assertAllowedPath(path, 'file');
  if (!existsSync(allowed) || !statSync(allowed).isFile()) {
    throw new Error(`file does not exist: ${allowed}`);
  }
  return {
    path: allowed,
    sha256: sha256File(allowed),
    bytes: statSync(allowed).size,
  };
}

export function findFiles(root, predicate, limit = 200) {
  const base = assertAllowedPath(root, 'search root');
  const output = [];
  const walk = (directory) => {
    if (output.length >= limit) return;
    for (const entry of readdirSafe(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'logs'].includes(entry.name)) continue;
        walk(path);
      } else if (entry.isFile() && predicate(path)) {
        output.push(path);
        if (output.length >= limit) return;
      }
    }
  };
  if (existsSync(base)) walk(base);
  return output;
}

function readdirSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
