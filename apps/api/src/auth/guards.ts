import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../config';
import { sessionCookieName, setSessionCookie } from './cookies';
import type { SessionService } from './sessions';
import { ApiProblem } from '../lib/errors';

export interface ProtectedRouteDependencies {
  config: ApiConfig;
  sessions: SessionService;
}

export type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Shared preHandler for browser-protected routes. It re-checks the server-side
 * session on every request, so a revoked session loses SSE, attachment and API
 * access immediately, not only when the cookie is next replaced.
 */
export function createAuthenticate(dependencies: ProtectedRouteDependencies): Authenticate {
  const { config, sessions } = dependencies;
  return async (request, reply) => {
    const token = request.cookies[sessionCookieName(config)] ?? '';
    const context = await sessions.resolve(token);
    if (!context) {
      throw ApiProblem.unauthorized();
    }
    request.auth = context;
    setSessionCookie(reply, config, token, context.session.expiresAt);
  };
}
