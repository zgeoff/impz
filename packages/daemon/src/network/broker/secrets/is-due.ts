import type { OAuthStateFile } from './oauth-state';

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
  const MIN_LEAD_MS = 3 * 60_000;

  if (state.refreshedAt === null) {
    return remaining < MIN_LEAD_MS;
  }

  const lifetime = state.expiresAt - state.refreshedAt;
  const MAX_LEAD_MS = 24 * HOUR_MS;

  return remaining < Math.max(MIN_LEAD_MS, Math.min(MAX_LEAD_MS, lifetime / 2));
}
