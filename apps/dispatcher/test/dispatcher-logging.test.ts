import { describe, expect, it } from 'vitest';

import { RuntimeBridgeError } from '@moyu/runtime-client';

import { runLoop } from '../src/dispatcher';
import type { DispatcherLogger } from '../src/logger';

interface Recorded {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(): { logger: DispatcherLogger; records: Recorded[] } {
  const records: Recorded[] = [];
  const write =
    (level: Recorded['level']) => (fields: Record<string, unknown>, message: string) => {
      records.push({ level, fields, message });
    };
  return {
    records,
    logger: { info: write('info'), warn: write('warn'), error: write('error') },
  };
}

describe('dispatcher loop failure levels', () => {
  it('warns twice, escalates on the third transient failure, and logs one recovery', async () => {
    const { logger, records } = recordingLogger();
    const controller = new AbortController();
    let calls = 0;
    await runLoop('event_sync', 0, controller.signal, logger, async () => {
      calls += 1;
      if (calls <= 3) {
        throw new RuntimeBridgeError('The runtime Bridge could not be reached', {
          retryable: true,
          code: 'bridge_unreachable',
        });
      }
      if (calls === 4) return false;
      controller.abort();
      return false;
    });

    expect(records.map((record) => record.level)).toEqual(['warn', 'warn', 'error', 'info']);
    expect(records.map((record) => record.fields.consecutiveFailures)).toEqual([1, 2, 3, 3]);
    expect(records[3]?.fields.event).toBe('dispatcher.event_sync_recovered');
  });

  it('keeps SQL and contract failures at error level and restarts transient counting', async () => {
    const { logger, records } = recordingLogger();
    const controller = new AbortController();
    let calls = 0;
    await runLoop('reports', 0, controller.signal, logger, async () => {
      calls += 1;
      if (calls === 1) {
        throw new RuntimeBridgeError('Runtime Bridge response did not match the shared contract', {
          retryable: false,
          code: 'bridge_invalid_response',
        });
      }
      if (calls === 2) throw new Error('syntax error in SQL projection');
      if (calls === 3) {
        throw new RuntimeBridgeError('The runtime Bridge could not be reached', {
          retryable: true,
          code: 'bridge_unreachable',
        });
      }
      controller.abort();
      return false;
    });

    expect(records.map((record) => record.level)).toEqual(['error', 'error', 'warn', 'info']);
    expect(records[0]?.fields).toMatchObject({
      transient: false,
      code: 'bridge_invalid_response',
    });
    expect(records[1]?.fields).toMatchObject({ transient: false });
    expect(records[2]?.fields).toMatchObject({
      transient: true,
      consecutiveFailures: 1,
    });
    expect(records[3]?.fields).toMatchObject({
      event: 'dispatcher.reports_recovered',
      consecutiveFailures: 1,
    });
  });
});
