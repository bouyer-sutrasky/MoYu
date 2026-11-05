import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';

/**
 * Machine-token guard for the Bridge callback surface. It only extracts and
 * shape-checks the bearer; the route verifies that token against the repository
 * that owns the target conversation, so repository A's token cannot post into B.
 */
export function createMachineAuthenticate(
  _config: ApiConfig,
): (request: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  return async (request) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw ApiProblem.unauthorized('Machine token is required');
    }
    const supplied = header.slice('Bearer '.length).trim();
    if (!supplied) {
      throw ApiProblem.unauthorized('Machine token is required');
    }
    request.machineToken = supplied;
  };
}
