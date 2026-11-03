/** Returns the PostgreSQL SQLSTATE and constraint of a thrown database error. */
export function postgresError(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: { code?: unknown; constraint?: unknown };
  };
  const nested = candidate.cause;
  return {
    code:
      typeof candidate.code === 'string'
        ? candidate.code
        : typeof nested?.code === 'string'
          ? nested.code
          : undefined,
    constraint:
      typeof candidate.constraint === 'string'
        ? candidate.constraint
        : typeof nested?.constraint === 'string'
          ? nested.constraint
          : undefined,
  };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const parsed = postgresError(error);
  return parsed.code === '23505' && (constraint === undefined || parsed.constraint === constraint);
}
