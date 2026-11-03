import type { FastifyReply } from 'fastify';

import type { ApiConfig } from '../config';

export function sessionCookieName(config: ApiConfig): string {
  return config.cookieSecure ? '__Host-moyu_session' : 'moyu_session';
}

export function bootstrapCookieName(config: ApiConfig): string {
  return config.cookieSecure ? '__Host-moyu_bootstrap' : 'moyu_bootstrap';
}

export function setSessionCookie(
  reply: FastifyReply,
  config: ApiConfig,
  token: string,
  expiresAt: Date,
): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(sessionCookieName(config), token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ApiConfig): void {
  reply.clearCookie(sessionCookieName(config), {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
  });
}

export function setBootstrapCookie(
  reply: FastifyReply,
  config: ApiConfig,
  token: string,
  expiresAt: Date,
): void {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(bootstrapCookieName(config), token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge,
  });
}

export function clearBootstrapCookie(reply: FastifyReply, config: ApiConfig): void {
  reply.clearCookie(bootstrapCookieName(config), {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
  });
}
