import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Machine-token guard for the Bridge callback surface. It is deliberately
 * separate from browser sessions: a browser cookie never authorizes machine
 * routes, and a machine token never authorizes browser routes.
 */
export function createMachineAuthenticate(
  config: ApiConfig,
): (request: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  return async (request) => {
    const expected = config.bridgeCallbackToken;
    if (!expected) {
      throw ApiProblem.unavailable('Bridge callback token is not configured');
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw ApiProblem.unauthorized('Machine token is required');
    }
    const supplied = header.slice('Bearer '.length).trim();
    if (!supplied || !timingSafeEqual(digest(supplied), digest(expected))) {
      throw ApiProblem.unauthorized('Machine token is invalid');
    }
  };
}
