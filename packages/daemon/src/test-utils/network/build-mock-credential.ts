import { faker } from '@faker-js/faker';
import type { Credential } from '../../network/broker/tls/admit-request';

export function buildMockCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    secretName: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u),
    header: 'authorization',
    value: `Bearer ${faker.string.alphanumeric(24)}`,
    upstream: null,
    identity: false,
    filter: null,
    oauth: null,
    ...overrides,
  };
}
