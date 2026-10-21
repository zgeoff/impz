import { faker } from '@faker-js/faker';
import type { ZfsEntry } from '../../src/vm/storage/zfs/zfs-commands';

export function buildMockZfsEntry(overrides: Partial<ZfsEntry> = {}): ZfsEntry {
  return {
    name: `tank/imp/disks/${faker.string.uuid()}`,
    type: 'filesystem',
    origin: null,
    deferDestroy: false,
    ...overrides,
  };
}
