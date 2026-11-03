import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Unambiguous alphabet: no 0/O, 1/I/L, so a printed code is easy to re-enter. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Generates a 12-character (~59 bit) one-time binding code, grouped for reading.
 * Only its SHA-256 digest is persisted.
 */
export function generateBootstrapCode(): string {
  let raw = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function normalizeBootstrapCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function safeEqualText(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
