import { faker } from '@faker-js/faker';
import type { LeaseRecord } from '../../src/platform/db/leases';

export function buildMockLeaseRecord(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    impId: faker.string.uuid(),
    principal: `token:${faker.string.uuid()}`,
    label: faker.word.verb(),
    display: faker.word.noun(),
    until: null,
    createdAt: faker.date.past(),
    ...overrides,
  };
}
