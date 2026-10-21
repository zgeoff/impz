import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import type { McpPrincipal } from '../http/create-http-transport';
import { buildImpGuard } from '../imp-guard';

export function buildMockMcpPrincipal(overrides: Partial<McpPrincipal> = {}): McpPrincipal {
  return {
    key: faker.internet.username(),
    scope: 'manage',
    client: createImpClient({ url: faker.internet.url() }),
    guard: buildImpGuard({ all: true }),
    ends: null,
    ...overrides,
  };
}
