import { faker } from '@faker-js/faker';
import type { BrokerRule } from '../schemas/secret-schema';

export function buildMockBrokerRule(overrides: Partial<BrokerRule> = {}): BrokerRule {
  return {
    host: faker.internet.domainName().toLowerCase(),
    header: 'authorization',
    scheme: 'bearer',
    ...overrides,
  };
}
