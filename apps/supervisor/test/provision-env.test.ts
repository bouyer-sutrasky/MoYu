import { describe, expect, it } from 'vitest';
import { instanceEnvironment, parseEnvFile } from '../src/provision';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('managed instance environment', () => {
  it('writes the admission enforcement flag by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm5b-env-'));
    try {
      const path = join(dir, 'instance.env');
      writeFileSync(
        path,
        instanceEnvironment({
          platformUrl: 'http://127.0.0.1:1',
          platformToken: 'callback',
          bridgeToken: 'bridge',
          bridgePort: 3901,
        }),
      );
      expect(parseEnvFile(path)).toMatchObject({
        MOYU_REQUIRE_ADMISSION: '1',
        MOYU_BRIDGE_PORT: '3901',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('managed instance environment test seam', () => {
  it('forwards the launch-stop test hook only while the test hook is on', () => {
    const previousHook = process.env.MOYU_TEST_HOOKS;
    const previousBound = process.env.MOYU_TEST_PAUSE_LAUNCH_MS;
    const environment = () =>
      parseTemp(
        instanceEnvironment({
          platformUrl: 'http://127.0.0.1:1',
          platformToken: 'callback',
          bridgeToken: 'bridge',
          bridgePort: 3901,
        }),
      );
    try {
      delete process.env.MOYU_TEST_HOOKS;
      delete process.env.MOYU_TEST_PAUSE_LAUNCH_MS;
      const off = environment();
      expect(off.MOYU_TEST_HOOKS).toBeUndefined();
      expect(off.MOYU_TEST_PAUSE_LAUNCH_MS).toBeUndefined();

      process.env.MOYU_TEST_HOOKS = '1';
      process.env.MOYU_TEST_PAUSE_LAUNCH_MS = '1';
      expect(environment()).toMatchObject({ MOYU_TEST_HOOKS: '1', MOYU_TEST_PAUSE_LAUNCH_MS: '1' });

      // A non-numeric override must not silently shorten or break the shipped bound.
      process.env.MOYU_TEST_PAUSE_LAUNCH_MS = 'soon';
      expect(environment().MOYU_TEST_PAUSE_LAUNCH_MS).toBe('10000');
    } finally {
      if (previousHook === undefined) delete process.env.MOYU_TEST_HOOKS;
      else process.env.MOYU_TEST_HOOKS = previousHook;
      if (previousBound === undefined) delete process.env.MOYU_TEST_PAUSE_LAUNCH_MS;
      else process.env.MOYU_TEST_PAUSE_LAUNCH_MS = previousBound;
    }
  });
});

/** Parses one environment text from a fresh temp file, as the supervisor does before launching a runtime. */
function parseTemp(text: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'm5b-env-hook-'));
  try {
    const path = join(dir, 'instance.env');
    writeFileSync(path, text);
    return parseEnvFile(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
