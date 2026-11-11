import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensurePrivateDir, writePrivate } from '../src/provision';

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'm5b-private-'));
}

describe('privileged instance files', () => {
  it('creates a 0700 directory and repairs an over-broad mode on rerun', () => {
    const root = sandbox();
    try {
      const dir = join(root, 'credentials');
      ensurePrivateDir(dir);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      chmodSync(dir, 0o755);
      ensurePrivateDir(dir);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a 0600 credential and overwrites it atomically on rerun', () => {
    const root = sandbox();
    try {
      const dir = join(root, 'credentials');
      ensurePrivateDir(dir);
      const file = join(dir, 'repository.json');
      writePrivate(file, '{"bridgeToken":"first"}\n');
      expect(readFileSync(file, 'utf8')).toBe('{"bridgeToken":"first"}\n');
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      writePrivate(file, '{"bridgeToken":"second"}\n');
      expect(readFileSync(file, 'utf8')).toBe('{"bridgeToken":"second"}\n');
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a symbolic-link credential file and leaves the host sentinel untouched', () => {
    const root = sandbox();
    try {
      const dir = join(root, 'credentials');
      ensurePrivateDir(dir);
      const sentinel = join(root, 'host-file');
      writeFileSync(sentinel, 'host content\n');
      symlinkSync(sentinel, join(dir, 'repository.json'));
      expect(() => writePrivate(join(dir, 'repository.json'), 'replaced')).toThrow(/symbolic link/);
      expect(existsSync(sentinel)).toBe(true);
      expect(readFileSync(sentinel, 'utf8')).toBe('host content\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a symbolic-link credential directory and writes nothing outside it', () => {
    const root = sandbox();
    try {
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      const dir = join(root, 'credentials');
      symlinkSync(elsewhere, dir);
      expect(() => writePrivate(join(dir, 'repository.json'), 'token')).toThrow(/symbolic link/);
      expect(existsSync(join(elsewhere, 'repository.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a symbolic link in the middle of the profile path', () => {
    const root = sandbox();
    try {
      const real = join(root, 'real');
      mkdirSync(real);
      const link = join(root, 'profiles');
      symlinkSync(real, link);
      expect(() => writePrivate(join(link, 'patch.yml'), 'token')).toThrow(/symbolic link/);
      expect(existsSync(join(real, 'patch.yml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
