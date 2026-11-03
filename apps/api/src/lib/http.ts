import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errorResponse, successResponse } from '@moyu/contracts';

import { ApiProblem } from './errors';

export function sendData<T>(reply: FastifyReply, request: FastifyRequest, data: T, status = 200) {
  return reply.code(status).send(successResponse(data, request.id));
}

export function sendProblem(reply: FastifyReply, request: FastifyRequest, problem: ApiProblem) {
  return reply
    .code(problem.statusCode)
    .send(errorResponse(problem.code, problem.message, problem.retryable, request.id));
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.join('.') || 'body';
    throw ApiProblem.invalid(`${location}: ${issue?.message ?? 'invalid request'}`);
  }
  return parsed.data;
}

export function clientIp(request: FastifyRequest): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}
