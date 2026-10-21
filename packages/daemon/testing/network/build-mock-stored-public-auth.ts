import { faker } from '@faker-js/faker';
import { buildCredentialHash } from '../../src/network/https/public-auth';
import type { StoredPublicAuth } from '../../src/platform/db/imps';

export function buildMockStoredPublicAuth(
  overrides: Partial<StoredPublicAuth> = {},
): StoredPublicAuth {
  return {
    auth: 'basic',
    user: faker.internet.username(),
    hash: buildCredentialHash(faker.string.alphanumeric(43)),
    ...overrides,
  };
}
