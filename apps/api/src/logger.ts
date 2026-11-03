import type { FastifyServerOptions } from 'fastify';

import type { ApiConfig } from './config';
import { SERVICE_NAME } from './version';

/**
 * Structured JSON logs with a stable service field. Authorization headers,
 * cookies and Set-Cookie values are redacted before serialization.
 */
export function createLoggerOptions(config: ApiConfig): FastifyServerOptions['logger'] {
  return {
    level: config.logLevel,
    base: {
      service: SERVICE_NAME,
      env: config.nodeEnv,
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };
}
