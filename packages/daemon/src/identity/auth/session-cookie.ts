import { isValidSignature } from '../../platform/secrets/is-valid-signature';
import { sign } from '../../platform/secrets/sign';

const SESSION_COOKIE = 'imp_session';

// Over HTTPS. The browser takes a __Host- cookie only Secure, host-only and on
// /, so no other name under the domain, an imp's included, can set one.
const SECURE_SESSION_COOKIE = '__Host-imp_session';

const SESSION_COOKIES: ReadonlySet<string> = new Set([SESSION_COOKIE, SECURE_SESSION_COOKIE]);

export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const VERSION = 'v2';

export interface SessionClaim {
  readonly tokenId: string;
  readonly expiresAt: number;
}

export function buildSessionValue(rootToken: string, claim: Readonly<SessionClaim>): string {
  const expiry = String(claim.expiresAt);

  return `${VERSION}.${claim.tokenId}.${expiry}.${buildSignature(rootToken, claim.tokenId, expiry)}`;
}

export function readSession(value: string, rootToken: string, nowMs: number): SessionClaim | null {
  const [version, tokenId, expiry, signature, ...rest] = value.split('.');

  if (
    version !== VERSION ||
    tokenId === undefined ||
    expiry === undefined ||
    signature === undefined ||
    rest.length > 0
  ) {
    return null;
  }

  if (!/^\d+$/u.test(expiry) || Number(expiry) <= nowMs) {
    return null;
  }

  return isValidSignature(
    buildSessionKey(rootToken),
    buildSignedText(tokenId, expiry),
    signature,
    'base64url',
  )
    ? { tokenId, expiresAt: Number(expiry) }
    : null;
}

export function readSessionCookies(header: string | null): string[] {
  if (header === null) {
    return [];
  }

  return header
    .split(';')
    .map((pair) => pair.trim().split('='))
    .filter(([key]) => SESSION_COOKIES.has(key ?? ''))
    .map(([, ...value]) => value.join('='));
}

export function stripSessionCookie(header: string): string | null {
  // a browser sends the session to every port of the host, imps' ports
  // included, so it never goes on to an imp
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !SESSION_COOKIES.has(pair.split('=')[0] ?? ''));

  return kept.length === 0 ? null : kept.join('; ');
}

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly options: {
    readonly path: '/';
    readonly maxAge: number;
    readonly httpOnly: true;
    readonly sameSite: 'strict';
    readonly secure: boolean;
  };
}

export function buildSessionCookie(value: string, secure: boolean): SessionCookie {
  return buildCookie(value, SESSION_MAX_AGE_S, secure);
}

export function buildClearedSessionCookies(secure: boolean): readonly SessionCookie[] {
  // a session set over plain HTTP reaches the HTTPS origin too, and over HTTP
  // a browser neither sets nor clears a __Host- cookie
  return secure
    ? [buildCookie('', 0, false), buildCookie('', 0, true)]
    : [buildCookie('', 0, false)];
}

function buildCookie(value: string, maxAgeS: number, secure: boolean): SessionCookie {
  return {
    name: secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE,
    value,
    options: { path: '/', maxAge: maxAgeS, httpOnly: true, sameSite: 'strict', secure },
  };
}

function buildSignature(rootToken: string, tokenId: string, expiry: string): string {
  return sign(buildSessionKey(rootToken), buildSignedText(tokenId, expiry)).toString('base64url');
}

function buildSignedText(tokenId: string, expiry: string): string {
  return `imp-session-${VERSION}.${tokenId}.${expiry}`;
}

// a key of its own, derived from the root token, so the MAC never keys on
// the token itself
function buildSessionKey(rootToken: string): Buffer {
  return sign(rootToken, 'imp-session-key');
}
