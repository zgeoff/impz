import { faker } from '@faker-js/faker';
import type { ImageUse } from '../../src/platform/db/images';

export function buildMockImageUse(overrides: Partial<ImageUse> = {}): ImageUse {
  return {
    id: faker.string.uuid(),
    name: faker.string.alphanumeric({ length: 12, casing: 'lower' }),
    digest: `sha256:${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}`,
    source: 'oci',
    sizeBytes: faker.number.int({ min: 1, max: 1024 ** 3 }),
    lastUsedAt: faker.date.past().getTime(),
    impCount: 0,
    ...overrides,
  };
}
