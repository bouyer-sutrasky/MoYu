export interface SupervisorLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<Level, number> = {
  trace: 0,
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export function createConsoleLogger(
  service: string,
  minimum: Level = 'info',
  sink: (line: string) => void = (line) => process.stdout.write(line),
): SupervisorLogger {
  const write = (level: Level, fields: Record<string, unknown>, message: string) => {
    if (ORDER[level] < ORDER[minimum]) return;
    sink(
      `${JSON.stringify({
        at: new Date().toISOString(),
        level,
        service,
        message,
        ...fields,
      })}\n`,
    );
  };
  return {
    debug: (fields, message) => write('debug', fields, message),
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
  };
}
