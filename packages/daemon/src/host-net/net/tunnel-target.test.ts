import { expect, mock, test } from 'bun:test';
import { buildRangeMatcher } from './range-matcher';
import { REFUSED_RANGES4 } from './ranges';
import {
  TunnelRefusedError,
  isRefusedAddress,
  requireUplinkRoute,
  resolveTunnelTarget,
} from './tunnel-target';

test.each([
  ['2001:db8:a::2'],
  ['2001:DB8:A::2'],
  ['2001:0db8:000a:0000:0000:0000:0000:0002'],
  ['10.66.0.1'],
  ['::ffff:10.66.0.1'],
])("it refuses the host's own address spelt %s", (address) => {
  expect(
    isRefusedAddress(address, new Set(['2001:db8:a::2', '10.66.0.1']), () => false),
  ).toBeTrue();
});

test("it lets through an address next to the host's own", () => {
  expect(
    isRefusedAddress('2001:db8:a::3', new Set(['2001:db8:a::2', '10.66.0.1']), () => false),
  ).toBeFalse();
});

test('it asks the reach policy about a mapped address as the IPv4 address it carries', () => {
  const isRefused = mock<(address: string) => boolean>(() => false);

  isRefusedAddress('::ffff:140.82.112.3', new Set(), isRefused);

  expect(isRefused).toHaveBeenCalledExactlyOnceWith('140.82.112.3');
});

test('it refuses an address the reach policy refuses', () => {
  expect(isRefusedAddress('140.82.112.3', new Set(), () => true)).toBeTrue();
});

test('it dials the first address of a name whose answers all pass', async () => {
  const target = await resolveTunnelTarget('public.test', {
    resolve: () => Promise.resolve(['140.82.112.3', '140.82.112.4']),
    readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
    isRefused: () => false,
    hasIPv6: false,
  });

  expect(target).toBe('140.82.112.3');
});

test('it refuses a name with any refused answer', () => {
  expect(
    resolveTunnelTarget('rebind.test', {
      resolve: () => Promise.resolve(['140.82.112.3', '127.0.0.1']),
      readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
      isRefused: buildRangeMatcher(REFUSED_RANGES4),
      hasIPv6: false,
    }),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'rebind.test resolves to 127.0.0.1, which a tunnel may not reach',
  );
});

test('it refuses a name with no answer', () => {
  expect(
    resolveTunnelTarget('none.test', {
      resolve: () => Promise.resolve([]),
      readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
      isRefused: () => false,
      hasIPv6: false,
    }),
  ).rejects.toThrowWithMessage(TunnelRefusedError, 'none.test has no address a tunnel may dial');
});

test("it refuses the host's own IP literal without DNS", () => {
  expect(
    resolveTunnelTarget('203.0.114.7', {
      readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
      isRefused: () => false,
      hasIPv6: false,
    }),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    '203.0.114.7 resolves to 203.0.114.7, which a tunnel may not reach',
  );
});

test('it dials a public IP literal as it is', async () => {
  const target = await resolveTunnelTarget('140.82.112.3', {
    readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
    isRefused: () => false,
    hasIPv6: false,
  });

  expect(target).toBe('140.82.112.3');
});

test('it resolves a name through the system resolver', async () => {
  const target = await resolveTunnelTarget('localhost', {
    readHostAddresses: () => new Set(),
    isRefused: () => false,
    hasIPv6: false,
  });

  expect(target).toBe('127.0.0.1');
});

test("it refuses the host's own interface address by default", () => {
  expect(
    resolveTunnelTarget('::1', { isRefused: () => false, hasIPv6: true }),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    '::1 resolves to ::1, which a tunnel may not reach',
  );
});

test.each([
  ['dual.test', ['2606:4700::1111', '140.82.112.3'], '140.82.112.3'],
  ['six.test', ['2606:4700::1111'], '2606:4700::1111'],
  ['mapped.test', ['::ffff:140.82.112.3'], '140.82.112.3'],
])('it dials %s by IPv4 first, a mapped answer as its IPv4', async (host, answers, expected) => {
  const target = await resolveTunnelTarget(host, {
    resolve: () => Promise.resolve(answers),
    readHostAddresses: () => new Set(['203.0.114.7', '10.66.0.1']),
    isRefused: () => false,
    hasIPv6: true,
  });

  expect(target).toBe(expected);
});

test.each([
  ['93.184.216.34', 'eth0'],
  ['2606:4700::1', 'eth1'],
])("it lets a public imp's tunnel to %s leave by uplink %s", (address, dev) => {
  expect(
    requireUplinkRoute('a.example', address, { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.resolve(dev),
    ),
  ).resolves.toBeUndefined();
});

test("it refuses a public imp's IPv4 tunnel that leaves by another interface", () => {
  expect(
    requireUplinkRoute('b.example', '44.0.0.9', { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.resolve('wg0'),
    ),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'b.example resolves to 44.0.0.9, which the host reaches by wg0, not by a default route',
  );
});

test("it refuses a public imp's IPv6 tunnel that leaves by the IPv4 uplink", () => {
  expect(
    requireUplinkRoute('c.example', '2606:4700::2', { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.resolve('eth0'),
    ),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'c.example resolves to 2606:4700::2, which the host reaches by eth0, not by a default route',
  );
});

test("it refuses a public imp's tunnel whose route cannot be read", () => {
  expect(
    requireUplinkRoute('d.example', '203.0.113.9', { ipv4: ['eth0'], ipv6: ['eth1'] }, () =>
      Promise.reject(new Error('RTNETLINK answers: Network is unreachable')),
    ),
  ).rejects.toThrowWithMessage(
    TunnelRefusedError,
    'd.example: no route to 203.0.113.9: RTNETLINK answers: Network is unreachable',
  );
});
