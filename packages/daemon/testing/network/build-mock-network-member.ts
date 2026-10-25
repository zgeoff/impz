import { faker } from '@faker-js/faker';
import type { NetworkMember } from '../../src/platform/db/networks';

export function buildMockNetworkMember(overrides: Partial<NetworkMember> = {}): NetworkMember {
  return {
    // faker's nouns include acronyms such as SUV, and a name is lowercase
    network: faker.word.noun().toLowerCase(),
    impId: faker.string.uuid(),
    name: faker.word.noun().toLowerCase(),
    slot: faker.number.int({ min: 0, max: 4095 }),
    guestIp: faker.internet.ipv4(),
    ...overrides,
  };
}
