import { faker } from '@faker-js/faker';
import type { OAuthStateFile } from '../../src/network/broker/secrets/oauth-state';

const HOUR_MS = 3_600_000;

export function buildMockOAuthStateFile(overrides: Partial<OAuthStateFile> = {}): OAuthStateFile {
  const refreshedAt = faker.date.past().getTime();

  return {
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: `fake-refresh-${faker.string.alphanumeric(12)}`,
    accessToken: `fake-access-${faker.string.alphanumeric(12)}`,
    idToken: `fake-id-${faker.string.alphanumeric(12)}`,
    expiresAt: refreshedAt + 240 * HOUR_MS,
    refreshedAt,
    status: 'ready',
    error: null,
    ...overrides,
  };
}
