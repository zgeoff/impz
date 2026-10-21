import { faker } from '@faker-js/faker';
import type { FirewallSlot } from '../../src/network/egress/egress-ruleset';

export function buildMockFirewallSlot(overrides: Partial<FirewallSlot> = {}): FirewallSlot {
  const slot = overrides.slot ?? faker.number.int({ min: 0, max: 4095 });

  return {
    slot,
    tap: `imp${String(slot)}`,
    guestIp: faker.internet.ipv4(),
    guestIp6: null,
    mode: 'open',
    cidrs: [],
    addresses: [],
    ...overrides,
  };
}
