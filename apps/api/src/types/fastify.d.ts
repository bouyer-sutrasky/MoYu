import type { AuthContext } from '../auth/sessions';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
