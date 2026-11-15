import type { ApiErrorCode } from '@moyu/contracts';

/**
 * A deliberate HTTP-level failure that the shared error handler renders with the
 * standard `{ error, requestId }` envelope. Unexpected exceptions stay 500.
 */
export class ApiProblem extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiProblem';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = options.retryable ?? statusCode >= 500;
  }

  static unauthorized(message = 'Authentication required'): ApiProblem {
    return new ApiProblem(401, 'unauthorized', message);
  }

  static forbidden(message = 'Request is not allowed'): ApiProblem {
    return new ApiProblem(403, 'forbidden', message);
  }

  static notFound(message = 'Resource not found'): ApiProblem {
    return new ApiProblem(404, 'not_found', message);
  }

  static conflict(message: string, retryable = false): ApiProblem {
    return new ApiProblem(409, 'conflict', message, { retryable });
  }

  static payloadTooLarge(message: string): ApiProblem {
    return new ApiProblem(413, 'payload_too_large', message);
  }

  static invalid(message: string): ApiProblem {
    return new ApiProblem(422, 'invalid_request', message);
  }

  static unavailable(message = 'Database is not configured', retryable = true): ApiProblem {
    return new ApiProblem(503, 'dependency_unavailable', message, { retryable });
  }
}
