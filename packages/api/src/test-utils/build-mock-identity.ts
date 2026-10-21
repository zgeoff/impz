import { faker } from '@faker-js/faker';
import type { Identity } from '../schemas/token-schema';

export function buildMockIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    kind: 'token',
    name: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u),
    scope: 'manage',
    imps: null,
    grantable: [],
    imageRefPrefix: null,
    ...overrides,
  };
}
