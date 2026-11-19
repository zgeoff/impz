import { faker } from '@faker-js/faker';
import type { NetworkRecord } from '../../platform/db/list-networks';

export function buildMockNetworkRecord(overrides: Partial<NetworkRecord> = {}): NetworkRecord {
  return {
    id: faker.string.uuid(),
    name: faker.string.alphanumeric({ length: 10, casing: 'lower' }),
    createdAt: faker.date.past(),
    imps: [],
    ...overrides,
  };
}
