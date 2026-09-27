import { readPref, writePref } from '../storage';
import { readCloudConfig } from './config';

/**
 * Cognito email/password auth with four plain fetch() calls — no SDK, no
 * SRP library. USER_PASSWORD_AUTH sends the password over TLS directly to
 * Cognito's own endpoint (the same party that verifies it); the app's API
 * never sees a password, only the JWTs Cognito issues. Tokens live in
 * localStorage next to the rest of the app's data.
 */

interface Session {
  email: string;
  idToken: string;
  refreshToken: string;
  /** epoch ms when the id token stops being usable */
  expiresAt: number;
}

const SESSION_PREF = 'cloudSession';

function endpoint(region: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

async function cognito<T>(target: string, body: Record<string, unknown>): Promise<T> {
  const config = readCloudConfig();
  if (!config) throw new Error('Cloud isn’t configured yet.');
  const response = await fetch(endpoint(config.region), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify({ ClientId: config.clientId, ...body }),
  });
  const data = (await response.json().catch(() => ({}))) as { __type?: string; message?: string } & T;
  if (!response.ok) {
    const kind = (data.__type ?? '').split('#').pop() ?? '';
    const friendly: Record<string, string> = {
      UsernameExistsException: 'An account with this email already exists — sign in instead.',
      NotAuthorizedException: 'Wrong email or password.',
      UserNotConfirmedException: 'CONFIRM', // sentinel: the UI switches to the code step
      CodeMismatchException: 'That code isn’t right — check the email again.',
      ExpiredCodeException: 'That code expired — resend a new one.',
      InvalidPasswordException: data.message ?? 'Password too weak (10 characters minimum).',
      UserNotFoundException: 'No account with this email — create one first.',
      LimitExceededException: 'Too many attempts — wait a few minutes.',
    };
    throw new Error(friendly[kind] ?? data.message ?? `Sign-in service error (${kind || response.status}).`);
  }
  return data;
}

function storeSession(session: Session): void {
  writePref(SESSION_PREF, JSON.stringify(session));
}

function readSession(): Session | null {
  try {
    const raw = readPref(SESSION_PREF);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.idToken && s.refreshToken ? s : null;
  } catch {
    return null;
  }
}

export function cloudEmail(): string | null {
  return readSession()?.email ?? null;
}

export function signOut(): void {
  writePref(SESSION_PREF, '');
}

export async function signUp(email: string, password: string): Promise<void> {
  await cognito('SignUp', { Username: email, Password: password });
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  await cognito('ConfirmSignUp', { Username: email, ConfirmationCode: code.trim() });
}

export async function resendCode(email: string): Promise<void> {
  await cognito('ResendConfirmationCode', { Username: email });
}

interface AuthResult {
  AuthenticationResult?: { IdToken?: string; RefreshToken?: string; ExpiresIn?: number };
}

export async function signIn(email: string, password: string): Promise<void> {
  const data = await cognito<AuthResult>('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const result = data.AuthenticationResult;
  if (!result?.IdToken || !result.RefreshToken) throw new Error('Sign-in didn’t return a session — try again.');
  storeSession({
    email,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresAt: Date.now() + ((result.ExpiresIn ?? 3600) - 60) * 1000,
  });
}

/** A fresh id token, silently refreshed when near expiry; null = signed out. */
export async function getIdToken(): Promise<string | null> {
  const session = readSession();
  if (!session) return null;
  if (Date.now() < session.expiresAt) return session.idToken;
  try {
    const data = await cognito<AuthResult>('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: session.refreshToken },
    });
    const result = data.AuthenticationResult;
    if (!result?.IdToken) throw new Error('no token');
    storeSession({
      ...session,
      idToken: result.IdToken,
      expiresAt: Date.now() + ((result.ExpiresIn ?? 3600) - 60) * 1000,
    });
    return result.IdToken;
  } catch {
    signOut(); // refresh token expired or revoked: back to signed-out, quietly
    return null;
  }
}
