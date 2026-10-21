import { faker } from '@faker-js/faker';
import type { PublicImp } from '../../src/platform/db/exposure';
import { buildMockStoredPublicAuth } from './build-mock-stored-public-auth';

export function buildMockPublicImp(overrides: Partial<PublicImp> = {}): PublicImp {
  return {
    id: faker.string.uuid(),
    state: 'running',
    stored: buildMockStoredPublicAuth(),
    ...overrides,
  };
}
