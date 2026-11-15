/**
 * Runtime health labels and the health record the Sources status view reports
 * (copied verbatim from the pinned upstream `sources/host.ts`).
 */

export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const;

export type HealthCode = keyof typeof HEALTH_TEXT;

/**
 * One health entry. Upstream's own type has no `name`; MoYu's Source status view
 * reports the check's name next to it, so it is optional here.
 */
export interface Health {
  name?: string;
  state: 'starting' | 'ready' | 'paused' | 'error' | string;
  detail: string;
  at?: string;
  code?: HealthCode;
  values?: Record<string, string>;
}
