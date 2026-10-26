import { faker } from '@faker-js/faker';
import type { NewAuditEntry } from '../../src/platform/db/broker-audit';

export function buildMockNewAuditEntry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    impId: faker.string.uuid(),
    impName: faker.string.alpha({ length: 10, casing: 'lower' }),
    secretName: faker.string.alpha({ length: 10, casing: 'lower' }),
    at: faker.date.recent(),
    method: 'GET',
    host: faker.internet.domainName(),
    path: `/${faker.word.noun()}`,
    status: 200,
    requestBytes: faker.number.int({ min: 0, max: 1024 ** 2 }),
    responseBytes: faker.number.int({ min: 0, max: 1024 ** 2 }),
    durationMs: faker.number.int({ min: 0, max: 60_000 }),
    reason: null,
    ...overrides,
  };
}
