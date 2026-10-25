import { faker } from '@faker-js/faker';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/platform/db/schema';

type MoveSendRow = Selectable<DB['move_sends']>;

export function buildMockMoveSendRow(overrides: Partial<MoveSendRow> = {}): MoveSendRow {
  return {
    imp_id: faker.string.uuid(),
    peer_url: null,
    ticket: null,
    total_bytes: faker.number.int({ min: 1, max: 64 * 1024 ** 3 }),
    mode: 'files',
    warm: 0,
    step: 'prepared',
    halted: 0,
    receipt: null,
    error: null,
    created_at: faker.date.recent().getTime(),
    ...overrides,
  };
}
