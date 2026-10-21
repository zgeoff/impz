import { faker } from '@faker-js/faker';
import type { Extent } from '../../src/vm/storage/fiemap';

export function buildMockExtent(overrides: Partial<Extent> = {}): Extent {
  return {
    logical: faker.number.int({ max: 1_000_000 }) * 4096,
    physical: faker.number.int({ max: 1_000_000 }) * 4096,
    length: faker.number.int({ min: 1, max: 1024 }) * 4096,
    flags: 0,
    ...overrides,
  };
}
