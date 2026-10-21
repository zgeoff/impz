import { faker } from '@faker-js/faker';
import { CHECKPOINT_ID_ALPHABET } from '../../src/imp-ops/checkpoints/checkpoint-service';
import type { CheckpointRecord } from '../../src/platform/db/checkpoints';

export function buildMockCheckpointRecord(
  overrides: Partial<CheckpointRecord> = {},
): CheckpointRecord {
  return {
    id: `cp-${faker.string.fromCharacters(CHECKPOINT_ID_ALPHABET, 6)}`,
    impId: faker.string.uuid(),
    label: faker.word.noun(),
    createdAt: faker.date.past(),
    sizeBytes: faker.number.int({ min: 1, max: 1024 ** 3 }),
    diskBytes: faker.number.int({ min: 1024 ** 3, max: 64 * 1024 ** 3 }),
    ...overrides,
  };
}
