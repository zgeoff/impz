import { faker } from '@faker-js/faker';
import type { TokenRecord } from '../../src/platform/db/tokens';
import { hashSecret } from '../../src/platform/secrets/hash-secret';

export function buildMockTokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: faker.string.alphanumeric(16),
    name: faker.word.noun(),
    secretHash: hashSecret(faker.string.alphanumeric(43)).toString('hex'),
    scope: 'manage',
    imps: null,
    grantable: [],
    imageRefPrefix: null,
    createdAt: faker.date.past(),
    ...overrides,
  };
}
