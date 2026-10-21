import { faker } from '@faker-js/faker';
import type { ImpDiskUsage } from '../../src/vm/storage/storage-backend';

export function buildMockImpDiskUsage(overrides: Partial<ImpDiskUsage> = {}): ImpDiskUsage {
  return {
    exclusiveBytes: faker.number.int({ max: 2 ** 40 }),
    sharedBytes: faker.number.int({ max: 2 ** 40 }),
    isUpperBound: false,
    ...overrides,
  };
}
