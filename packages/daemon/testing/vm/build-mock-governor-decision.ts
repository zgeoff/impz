import { faker } from '@faker-js/faker';
import { EVENT_VERSION } from '@impz/api';
import type { ImpEvent } from '@impz/api';

type GovernorDecision = Extract<ImpEvent, { ev: 'GovernorDecision' }>;

export function buildMockGovernorDecision(
  overrides: Partial<GovernorDecision> = {},
): GovernorDecision {
  return {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: faker.date.recent(),
    ev: 'GovernorDecision',
    decision: 'admitted',
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    trigger: 'admission',
    usedMib: faker.number.int({ min: 0, max: 4096 }),
    budgetMib: faker.number.int({ min: 4097, max: 65_536 }),
    ...overrides,
  };
}
