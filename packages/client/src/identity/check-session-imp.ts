import type { SessionCheck, SessionHost, VerifiedImp } from './types';

// `session` is the session host's answer for the session id in the request
// body, or null when it lists none. Sessions in one imp pass for each other:
// the imp is the trust boundary.
export function checkSessionImp(
  caller: Readonly<VerifiedImp> | null,
  session: Readonly<SessionHost> | null,
): SessionCheck {
  if (caller === null) {
    return { kind: 'refused', reason: 'no-identity' };
  }

  if (session === null) {
    return { kind: 'refused', reason: 'unknown-session' };
  }

  if (session.impName === null) {
    return { kind: 'refused', reason: 'not-in-an-imp' };
  }

  // A name is free again after a destroy, so the check never falls back to it.
  if (session.impID === null) {
    return { kind: 'refused', reason: 'imp-id-unknown' };
  }

  // An id is unique on one impd only: a backup of a running imp, restored on a
  // second host, gives a second imp with the same id.
  if (session.impIssuer === null) {
    return { kind: 'refused', reason: 'imp-issuer-unknown' };
  }

  if (session.impIssuer !== caller.issuer) {
    return { kind: 'refused', reason: 'other-host' };
  }

  return session.impID === caller.id
    ? { kind: 'allowed' }
    : { kind: 'refused', reason: 'other-imp' };
}
