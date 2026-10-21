import { faker } from '@faker-js/faker';
import type { OAuthConfig } from '../schemas/secret-schema';

export function buildMockOAuthConfig(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    tokenUrl: `https://${faker.internet.domainName().toLowerCase()}/oauth/token`,
    clientId: faker.string.alphanumeric(16),
    tokenFormat: 'form',
    ...overrides,
  };
}
