import { faker } from '@faker-js/faker';
import type { NetworkMember } from '../../src/platform/db/networks';

export function buildMockNetworkMember(overrides: Partial<NetworkMember> = {}): NetworkMember {
  return {
    network: faker.word.noun(),
    impId: faker.string.uuid(),
    name: faker.word.noun(),
    slot: faker.number.int({ min: 0, max: 4095 }),
    guestIp: faker.internet.ipv4(),
    ...overrides,
  };
}
