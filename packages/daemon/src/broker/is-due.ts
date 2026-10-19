import type { OAuthStateFile } from './oauth-state';

// Due now without an access token, never for needs_login; else with less
// than min(24 h, half the lifetime) left, and never less than MIN_LEAD_MS, so
// an impd stopped for a day never hands out an expired token.
export function isDue(state: Readonly<OAuthStateFile>, at: number): boolean {
  if (state.status === 'needs_login') {
    return false;
  }

  if (state.status === 'pending' || state.accessToken === null) {
    return true;
  }

  const HOUR_MS = 60 * 60 * 1000;

  if (state.expiresAt === null) {
    return state.refreshedAt === null || at - state.refreshedAt > HOUR_MS;
  }

  const remaining = state.expiresAt - at;

  // at least one 60 s tick and one 30 s token call before the expiry, with
  // room to spare, so a short-lived token is refreshed before it runs out
  const MIN_LEAD_MS = 3 * 60_000;

  if (state.refreshedAt === null) {
    return remaining < MIN_LEAD_MS;
  }

  const lifetime = state.expiresAt - state.refreshedAt;
  const MAX_LEAD_MS = 24 * HOUR_MS;

  return remaining < Math.max(MIN_LEAD_MS, Math.min(MAX_LEAD_MS, lifetime / 2));
}
