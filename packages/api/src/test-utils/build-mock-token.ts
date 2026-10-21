import { faker } from '@faker-js/faker';
import type { Token } from '../schemas/token-schema';

export function buildMockToken(overrides: Partial<Token> = {}): Token {
  return {
    name: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u),
    scope: 'manage',
    imps: null,
    sshKeys: [],
    grantable: [],
    imageRefPrefix: null,
    createdAt: faker.date.past(),
    ...overrides,
  };
}
