import { describe, expect, it } from 'vitest';

import { PANEL_READ_PATHS, isSettingsBlock, panelErrorText } from '../src/panel-proxy';

describe('panel proxy allow-lists', () => {
  it('accepts the fixed settings blocks and any source block', () => {
    for (const block of [
      'policy',
      'eval',
      'executor',
      'pause',
      'source:github',
      'source:workspace',
    ]) {
      expect(isSettingsBlock(block)).toBe(true);
    }
  });

  it('refuses anything that is not a settings block', () => {
    for (const block of [
      '',
      'executor/../../etc/passwd',
      'settings',
      'source:',
      'source:GitHub',
      'source:github/../x',
      ' policy',
      'policy ',
      'source:github:pause',
    ]) {
      expect(isSettingsBlock(block)).toBe(false);
    }
  });

  it('exposes only the read pages the settings UI uses', () => {
    expect([...PANEL_READ_PATHS].sort()).toEqual([
      '/models',
      '/policy/history',
      '/prompts',
      '/settings',
      '/sources',
      '/state',
    ]);
    for (const path of ['/tickets', '/settings/policy', '/executor/pause', '/../etc']) {
      expect(PANEL_READ_PATHS.has(path)).toBe(false);
    }
  });

  it('summarises a panel error without leaking the whole body', () => {
    expect(
      panelErrorText({ status: 409, body: { error: 'Settings changed. Reload before saving.' } }),
    ).toBe('Settings changed. Reload before saving.');
    expect(panelErrorText({ status: 500, body: null })).toBe('panel responded 500');
    expect(
      panelErrorText({ status: 422, body: { issues: [{ path: 'value', message: 'x' }] } }),
    ).toBe('[{"path":"value","message":"x"}]');
  });
});
