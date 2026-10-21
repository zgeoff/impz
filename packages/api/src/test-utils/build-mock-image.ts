import { faker } from '@faker-js/faker';
import type { Image } from '../schemas/image-schema';

export function buildMockImage(overrides: Partial<Image> = {}): Image {
  const name = faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u);

  return {
    id: faker.string.uuid(),
    name,
    ref: `${name}:${faker.system.semver()}`,
    digest: `sha256:${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}`,
    source: 'oci',
    createdAt: faker.date.past(),
    sizeBytes: faker.number.int({ min: 1, max: 2 ** 34 }),
    ...overrides,
  };
}
