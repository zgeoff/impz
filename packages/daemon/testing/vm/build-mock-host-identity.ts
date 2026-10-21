import { faker } from '@faker-js/faker';
import type { HostIdentity } from '../../src/vm/sleep/vm-identity';

export function buildMockHostIdentity(overrides: Partial<HostIdentity> = {}): HostIdentity {
  const systemDrive =
    overrides.systemDrive ?? faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' });

  return {
    firecrackerVersion: `v${faker.system.semver()}`,
    snapshotVersion: `v${faker.system.semver()}`,
    hostKernel: faker.system.semver(),
    guestKernel: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
    systemDrive,
    systemDrivePath: `/data/system/drives/${systemDrive}.squashfs`,
    ipv6Prefix: null,
    cpuModel: faker.commerce.productName(),
    cpuFlags: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
    ...overrides,
  };
}
