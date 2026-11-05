import type { AuthContext } from '../auth/sessions';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    /** Raw machine token, verified against the repository in the route. */
    machineToken?: string;
  }
}
