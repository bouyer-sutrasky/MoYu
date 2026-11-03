import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';

import type { PasskeyCredential } from '@moyu/db';

import type { ApiConfig } from '../config';

/**
 * Single-owner WebAuthn user handle. It is stable across first registration and
 * recovery, so an authenticator replaces the same discoverable user instead of
 * accumulating orphaned handles. It is not a secret.
 */
const OWNER_USER_HANDLE = new TextEncoder().encode('moyu-owner-v1');
const OWNER_USER_NAME = 'moyu-owner';

export interface CredentialDescriptor {
  id: string;
  transports: string[];
}

function descriptors(credentials: CredentialDescriptor[]) {
  return credentials.map((credential) => ({
    id: credential.id,
    transports: credential.transports,
  }));
}

export function generateRegistrationOptionsFor(
  config: ApiConfig,
  activeCredentials: CredentialDescriptor[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: config.webauthnRpName,
    rpID: config.webauthnRpId,
    userName: OWNER_USER_NAME,
    userID: OWNER_USER_HANDLE,
    userDisplayName: 'MoYu Owner',
    attestationType: 'none',
    excludeCredentials: descriptors(activeCredentials),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    timeout: 60_000,
  });
}

export function generateAuthenticationOptionsFor(
  config: ApiConfig,
  activeCredentials: CredentialDescriptor[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    allowCredentials: descriptors(activeCredentials),
    userVerification: 'required',
    timeout: 60_000,
  });
}

export function verifyRegistration(
  config: ApiConfig,
  input: { response: RegistrationResponseJSON; expectedChallenge: string },
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: config.webauthnOrigin,
    expectedRPID: config.webauthnRpId,
    requireUserVerification: true,
  });
}

export function verifyAuthentication(
  config: ApiConfig,
  input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: PasskeyCredential;
  },
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: config.webauthnOrigin,
    expectedRPID: config.webauthnRpId,
    credential: {
      id: input.credential.credentialId,
      publicKey: Buffer.from(input.credential.publicKey, 'base64url'),
      counter: input.credential.counter,
      transports: input.credential.transports,
    },
    requireUserVerification: true,
  });
}

export function toCredentialDescriptor(credential: PasskeyCredential): CredentialDescriptor {
  return { id: credential.credentialId, transports: credential.transports };
}
