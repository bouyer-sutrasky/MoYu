export interface DispatcherLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Minimal JSON-lines logger for the dispatcher process. The API uses Fastify's
 * pino logger; the dispatcher stays dependency-free so its startup output is
 * machine-readable in systemd/journald as well.
 */
export function createConsoleLogger(service: string): DispatcherLogger {
  const write = (level: 'info' | 'error', fields: Record<string, unknown>, message: string) => {
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      service,
      ...fields,
      msg: message,
    });
    if (level === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  };

  return {
    info: (fields, message) => write('info', fields, message),
    error: (fields, message) => write('error', fields, message),
  };
}
