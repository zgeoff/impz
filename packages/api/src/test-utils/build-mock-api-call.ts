import { faker } from '@faker-js/faker';
import type { ApiCall } from '../schemas/api-call-schema';

export function buildMockApiCall(overrides: Partial<ApiCall> = {}): ApiCall {
  return {
    at: faker.date.past(),
    procedure: faker.helpers.arrayElement(['imps.stop', 'imps.start', 'imps.create']),
    actor: 'token',
    actorName: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u),
    imp: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u),
    outcome: 'ok',
    durationMs: faker.number.int({ min: 0, max: 10_000 }),
    ...overrides,
  };
}
