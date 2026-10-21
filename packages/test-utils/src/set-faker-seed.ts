import { faker as sharedFaker } from '@faker-js/faker';
import type { Faker } from '@faker-js/faker';

export function setFakerSeed(faker: Faker = sharedFaker): void {
  faker.seed(135);
  faker.setDefaultRefDate(new Date('2026-01-01T00:00:00.000Z'));
}
