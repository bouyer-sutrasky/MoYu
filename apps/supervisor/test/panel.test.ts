import { describe, expect, it } from 'vitest';

import { orderProfileBlocks } from '../src/panel';

describe('profile configuration order', () => {
  it('saves the GitHub Source that probes the account before restart-triggering sources', () => {
    const ordered = orderProfileBlocks([
      { block: 'source:workspace' },
      { block: 'policy' },
      { block: 'source:github' },
      { block: 'executor' },
    ]);
    expect(ordered.map((block) => block.block)).toEqual([
      'source:github',
      'source:workspace',
      'policy',
      'executor',
    ]);
  });

  it('keeps the original order when the GitHub Source is unchanged', () => {
    const blocks = [{ block: 'source:workspace' }, { block: 'executor' }];
    expect(orderProfileBlocks(blocks)).toEqual(blocks);
  });
});
