import { describe, expect, it } from 'vitest';

import { applyDeploymentOps, deploymentRevision, readDeployment } from '../src/deployment-config';

const PROFILE = `# MoYu profile template
- id: webserver
  config:
    host: 127.0.0.1
    port: 3463
- id: dsh-superagent
  config:
    stateDir: /var/lib/moyu-m6c/dsh/state/m6c-b
    promptMaxChars: 100000
    admissionContextMaxPages: 10
    admissionContextTimeoutMs: 15000
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      commandcode:
        displayName: Command Code
`;

describe('readDeployment', () => {
  it('reads the three writable limits and the platform stateDir', () => {
    const snapshot = readDeployment(PROFILE);
    expect(snapshot).toMatchObject({ status: 'ready', writable: true, mode: 'config' });
    expect(snapshot.value).toEqual({
      promptMaxChars: 100000,
      admissionContextMaxPages: 10,
      admissionContextTimeoutMs: 15000,
    });
    expect(snapshot.stateDir).toBe('/var/lib/moyu-m6c/dsh/state/m6c-b');
  });

  it('keeps unset keys null instead of inventing zero', () => {
    const sparse = PROFILE.replace(
      /^\s*(promptMaxChars|admissionContextMaxPages|admissionContextTimeoutMs):.*\n/gm,
      '',
    );
    const snapshot = readDeployment(sparse);
    expect(snapshot.value).toEqual({
      promptMaxChars: null,
      admissionContextMaxPages: null,
      admissionContextTimeoutMs: null,
    });
  });

  it('does not read another block as the dsh-superagent config', () => {
    const snapshot = readDeployment(PROFILE);
    expect(snapshot.value.promptMaxChars).toBe(100000);
  });
});

describe('applyDeploymentOps', () => {
  it('updates a value in place and leaves the rest of the file byte-identical', () => {
    const result = applyDeploymentOps(PROFILE, [
      { op: 'set', path: ['promptMaxChars'], value: 200000 },
    ]);
    expect(result.applied).toEqual(['promptMaxChars']);
    expect(result.text).toContain('    promptMaxChars: 200000\n');
    expect(result.text).toContain('    admissionContextMaxPages: 10\n');
    expect(result.text).toContain('  stateDir: /var/lib/moyu-m6c/dsh/state/m6c-b\n');
    expect(result.text.replace('200000', '100000')).toBe(PROFILE);
    expect(result.revision).not.toBe(deploymentRevision(PROFILE));
  });

  it('inserts a missing key inside the config mapping, not after the block', () => {
    const sparse = PROFILE.replace(/^\s*promptMaxChars:.*\n/gm, '');
    const result = applyDeploymentOps(sparse, [
      { op: 'set', path: ['promptMaxChars'], value: 5000 },
    ]);
    const lines = result.text.split('\n');
    const index = lines.findIndex((line) => line.includes('promptMaxChars: 5000'));
    expect(index).toBeGreaterThan(-1);
    // The new key must land inside the dsh-superagent config mapping, i.e. before
    // the next list item, not after the block.
    const nextItem = lines.findIndex((line) => line.startsWith('- id: llm-pi-ai'));
    expect(index).toBeLessThan(nextItem);
    expect(readDeployment(result.text).value.promptMaxChars).toBe(5000);
  });

  it('unsets a key without touching its neighbours', () => {
    const result = applyDeploymentOps(PROFILE, [
      { op: 'unset', path: ['admissionContextMaxPages'] },
    ]);
    expect(result.text).not.toContain('admissionContextMaxPages');
    expect(result.text).toContain('promptMaxChars: 100000');
    expect(result.text).toContain('admissionContextTimeoutMs: 15000');
  });

  it('applies several operations in one pass', () => {
    const result = applyDeploymentOps(PROFILE, [
      { op: 'set', path: ['promptMaxChars'], value: 1000 },
      { op: 'set', path: ['admissionContextMaxPages'], value: 100 },
      { op: 'unset', path: ['admissionContextTimeoutMs'] },
    ]);
    expect(readDeployment(result.text).value).toEqual({
      promptMaxChars: 1000,
      admissionContextMaxPages: 100,
      admissionContextTimeoutMs: null,
    });
  });

  it('refuses the platform-managed stateDir', () => {
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['stateDir'], value: '/tmp/elsewhere' }]),
    ).toThrow(/platform-managed/);
  });

  it('refuses unknown keys and nested paths', () => {
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['providers'], value: 1 }]),
    ).toThrow(/platform-managed or unknown/);
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['promptMaxChars', 'nested'], value: 1 }]),
    ).toThrow(/Unsupported deployment path/);
  });

  it('enforces the upstream bounds', () => {
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['promptMaxChars'], value: 999 }]),
    ).toThrow(/between 1000 and 1000000/);
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['admissionContextMaxPages'], value: 101 }]),
    ).toThrow(/between 1 and 100/);
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 0 }]),
    ).toThrow(/between 1 and 90000/);
  });

  it('refuses non-integers', () => {
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 1.5 }]),
    ).toThrow(/integer/);
    expect(() =>
      applyDeploymentOps(PROFILE, [{ op: 'set', path: ['promptMaxChars'], value: 'abc' }]),
    ).toThrow(/integer/);
  });

  it('fails closed when the block is missing', () => {
    expect(() =>
      applyDeploymentOps('- id: webserver\n  config:\n    port: 1\n', [
        { op: 'set', path: ['promptMaxChars'], value: 5000 },
      ]),
    ).toThrow(/no dsh-superagent config block/);
  });
});
