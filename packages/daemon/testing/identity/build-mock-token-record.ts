import { createHash } from 'node:crypto';
import { faker } from '@faker-js/faker';
import type { TokenRecord } from '../../src/platform/db/tokens';

export function buildMockTokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: faker.string.alphanumeric(16),
    name: faker.word.noun(),
    secretHash: createHash('sha256').update(faker.string.alphanumeric(43)).digest('hex'),
    scope: 'manage',
    imps: null,
    grantable: [],
    imageRefPrefix: null,
    createdAt: faker.date.past(),
    ...overrides,
  };
}
