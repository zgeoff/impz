import { expect, test } from 'bun:test';
import { buildMockHostIdentity } from '../../testing/vm/build-mock-host-identity';
import { collectOutdatedParts } from './vm-identity';

test('it finds nothing outdated in a VM booted as the host boots now', () => {
  const host = buildMockHostIdentity();

  expect(collectOutdatedParts(host, host)).toStrictEqual([]);
});

test('it names each part the host has a newer one of', () => {
  const host = buildMockHostIdentity();

  expect(
    collectOutdatedParts(
      { firecrackerVersion: 'v0.0.1', guestKernel: 'old', systemDrive: 'old' },
      host,
    ),
  ).toStrictEqual(['firecracker', 'kernel', 'agent']);
});

test.each([
  ['no prefix', null],
  ['a prefix left out by an older impd', undefined],
])('it names ipv6 for a VM with %s on a host with IPv6', (_label, ipv6Prefix) => {
  const host = buildMockHostIdentity({ ipv6Prefix: 'fd12:3456:789a::/64' });

  expect(collectOutdatedParts({ ...host, ipv6Prefix }, host)).toStrictEqual(['ipv6']);
});

test('it names no ipv6 when the host has IPv6 off', () => {
  const host = buildMockHostIdentity({ ipv6Prefix: null });

  expect(collectOutdatedParts(host, host)).toStrictEqual([]);
});
