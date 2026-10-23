import { faker } from '@faker-js/faker';
import type { ImageBuildProgress } from '../schemas/image-op-event-schema';

export function buildMockImageBuildProgress(
  overrides: Partial<ImageBuildProgress> = {},
): ImageBuildProgress {
  return {
    type: 'progress',
    phase: 'pull',
    elapsedMs: faker.number.int({ min: 0, max: 3_600_000 }),
    ...overrides,
  };
}
