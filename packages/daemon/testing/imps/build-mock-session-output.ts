import { faker } from '@faker-js/faker';
import type { SessionOutput } from '@impz/api';

type OffsetsOutput = Extract<SessionOutput, { continuity: 'offsets' }>;

export function buildMockSessionOutput(overrides: Partial<OffsetsOutput> = {}): OffsetsOutput {
  const end = overrides.end ?? faker.number.int({ min: 0, max: 1_000_000 });

  return {
    continuity: 'offsets',
    bootId: faker.string.uuid(),
    executionGeneration: faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' }),
    bufferStart: 0,
    end,
    offset: end,
    prelude: 0,
    coldBoots: [],
    ...overrides,
  };
}
