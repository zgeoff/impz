import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubIpCommand } from '../../../testing/host-net/build-stub-ip-command';
import {
  parseConnectedPrefixes,
  parseRouteDevice,
  parseUplinks,
  readConnectedPrefixes,
  readIpv6DefaultRoute,
  readRouteDevice,
  readUplinks,
} from './host-routes';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-host-routes-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('#parseConnectedPrefixes reads the on-link IPv4 networks and every address off the taps', () => {
  const routes = [
    'default via 172.17.0.1 dev eth0',
    '10.66.0.0/30 dev imp0 proto kernel scope link src 10.66.0.1',
    '44.0.0.0/24 dev eth1 proto kernel scope link src 44.0.0.9',
    '172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2',
    '192.168.7.0/24 via 172.17.0.1 dev eth0',
    'blackhole 203.0.113.0/24',
    '198.18.5.7 dev wg0 scope link',
    '',
  ].join('\n');

  const addresses = [
    String.raw`1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever`,
    String.raw`2: imp0    inet 10.66.0.1/30 scope global imp0\       valid_lft forever preferred_lft forever`,
    String.raw`3: eth0    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0\       valid_lft forever`,
    String.raw`4: eth1    inet 44.0.0.9/24 scope global eth1\       valid_lft forever preferred_lft forever`,
    String.raw`5: tailscale0    inet 100.101.102.103/32 scope global tailscale0\       valid_lft forever`,
  ].join('\n');

  expect(parseConnectedPrefixes('ipv4', routes, addresses)).toStrictEqual([
    '44.0.0.0/24',
    '172.17.0.0/16',
    '198.18.5.7/32',
    '127.0.0.0/8',
    '127.0.0.1/32',
    '172.17.0.2/32',
    '44.0.0.9/32',
    '100.101.102.103/32',
  ]);
});

test('#parseConnectedPrefixes reads the on-link IPv6 routes and global addresses off the taps', () => {
  const routes = [
    '2001:db8:a::/64 dev eth0 proto kernel metric 256 pref medium',
    '2001:DB8:0e::/64 dev eth1 proto ra metric 1024 expires 86000sec pref medium',
    'fd00:1::/64 dev eth1 proto kernel metric 256 pref medium',
    'fd12:3456:789a::a42:2 dev imp0 metric 1024 pref medium',
    'fe80::/64 dev eth0 proto kernel metric 256 pref medium',
    'unreachable 2001:db8:dead::/48 dev lo metric 1024 pref medium',
    'default via 2001:db8:a::1 dev eth0 metric 1024 pref medium',
  ].join('\n');

  const addresses = [
    '1: lo    inet6 ::1/128 scope host noprefixroute',
    '2: eth0    inet6 2001:0db8:000a:0000::2/64 scope global',
    '3: eth2    inet6 2001:db8:f:0:1234::9/80 scope global dynamic mngtmpaddr',
    '4: imp0    inet6 fe80::1/64 scope link nodad',
    '5: imp1    inet6 fd12:3456:789a::1/64 scope global',
    '2: eth0    inet6 fe80::42:acff:fe11:2/64 scope link',
  ].join('\n');

  expect(parseConnectedPrefixes('ipv6', routes, addresses)).toStrictEqual([
    '2001:db8:a::/64',
    '2001:db8:e::/64',
    'fd00:1::/64',
    '2001:db8:f:0:1234::/80',
  ]);
});

test.each([
  [
    'ipv4',
    {
      'ip -4 route show': '172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2\n',
      'ip -4 -o addr show': String.raw`3: eth0    inet 172.17.0.2/16 scope global eth0\       valid_lft forever`,
    },
    ['172.17.0.0/16', '172.17.0.2/32'],
  ],
  [
    'ipv6',
    {
      'ip -6 route show': '2001:db8:a::/64 dev eth0 proto kernel metric 256 pref medium\n',
      'ip -6 -o addr show': '3: eth2    inet6 2001:db8:f::9/64 scope global\n',
    },
    ['2001:db8:a::/64', '2001:db8:f::/64'],
  ],
] as const)(
  '#readConnectedPrefixes reads the connected %s prefixes from the host routes and addresses',
  async (family, outputs, expected) => {
    const ip = buildStubIpCommand({ outputs });

    const prefixes = await readConnectedPrefixes(family, ip.runChecked);

    expect(prefixes).toStrictEqual(expected);
  },
);

test('#readConnectedPrefixes fails when ip fails', () => {
  const ip = buildStubIpCommand({
    outputs: { 'ip -4 route show': '172.17.0.0/16 dev eth0 proto kernel scope link\n' },
    failures: { 'ip -4 -o addr': 'Cannot open netlink socket' },
  });

  expect(readConnectedPrefixes('ipv4', ip.runChecked)).rejects.toThrowWithMessage(
    Error,
    'ip -4 -o addr show exited 2: Cannot open netlink socket',
  );
});

test('#readIpv6DefaultRoute reads the device of the first IPv6 default route', async () => {
  const ip = buildStubIpCommand({
    outputs: {
      'ip -6 route show default': [
        'default via fe80::1 dev eth1 metric 1024 pref medium',
        'default via fe80::2 dev eth2 metric 2048 pref medium',
        '',
      ].join('\n'),
    },
  });

  const dev = await readIpv6DefaultRoute(ip.run);

  expect(dev).toBe('eth1');
});

test("#readIpv6DefaultRoute reads a multipath default route's first uplink", async () => {
  const ip = buildStubIpCommand({
    outputs: {
      'ip -6 route show default': [
        'default proto ra metric 1024 expires 1797sec pref medium',
        '\tnexthop via fe80::1 dev eth0 weight 1',
        '\tnexthop via fe80::2 dev eth1 weight 1',
        '',
      ].join('\n'),
    },
  });

  const dev = await readIpv6DefaultRoute(ip.run);

  expect(dev).toBe('eth0');
});

test('#readIpv6DefaultRoute reads no IPv6 default route when there is none', async () => {
  const ip = buildStubIpCommand({ outputs: { 'ip -6 route show default': '' } });

  const dev = await readIpv6DefaultRoute(ip.run);

  expect(dev).toBeNull();
});

test('#readIpv6DefaultRoute reads no IPv6 default route when ip fails', async () => {
  const ip = buildStubIpCommand({
    failures: { 'ip -6 route': 'RTNETLINK answers: Address family not supported by protocol' },
  });

  const dev = await readIpv6DefaultRoute(ip.run);

  expect(dev).toBeNull();
});

test("#parseUplinks reads the default routes' interfaces as the uplinks, never a tap", () => {
  const routes = [
    'default via 172.17.0.1 dev eth0',
    'default via fe80::1 dev eth0 metric 1024 pref medium',
    'default dev wg0 scope link',
    '172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2',
    'default via 10.66.0.1 dev imp0',
  ].join('\n');

  expect(parseUplinks(routes)).toStrictEqual(['eth0', 'wg0']);
});

test('#parseUplinks reads no uplinks from no routes', () => {
  expect(parseUplinks('')).toStrictEqual([]);
});

test("#parseUplinks reads a multipath default route's uplinks from its nexthop lines", () => {
  const routes = [
    'default proto ra metric 1024 expires 1797sec pref medium',
    '\tnexthop via fe80::1 dev eth0 weight 1',
    '\tnexthop via fe80::2 dev eth1 weight 1',
    '\tnexthop via fe80::3 dev imp4 weight 1',
    '2001:db8:1::/64 proto static metric 1024 pref medium',
    '\tnexthop via fe80::9 dev wg0 weight 1',
  ].join('\n');

  expect(parseUplinks(routes)).toStrictEqual(['eth0', 'eth1']);
});

test('#readUplinks reads the uplinks of each family from the default routes', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip -4 route show default': 'default via 172.17.0.1 dev eth0\n',
      'ip -6 route show default': 'default via fe80::1 dev eth1 metric 1024 pref medium\n',
    },
  });

  await mkdir(join(ctx.directoryPath, 'ipv6'));

  const uplinks = await readUplinks(join(ctx.directoryPath, 'ipv6'), ip.runChecked);

  expect(uplinks).toStrictEqual({ ipv4: ['eth0'], ipv6: ['eth1'] });
});

test('#readUplinks reads no IPv6 uplinks, and runs no IPv6 read, on a kernel without IPv6', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: { 'ip -4 route show default': 'default via 172.17.0.1 dev eth0\n' },
  });

  const uplinks = await readUplinks(join(ctx.directoryPath, 'ipv6'), ip.runChecked);

  expect(uplinks).toStrictEqual({ ipv4: ['eth0'], ipv6: [] });
  expect(ip.calls).toStrictEqual(['ip -4 route show default']);
});

test.each([
  ['93.184.216.34 via 172.17.0.1 dev eth0 src 172.17.0.2 uid 0\n    cache\n', 'eth0'],
  ['local 172.17.0.2 dev lo table local src 172.17.0.2', 'lo'],
])('#parseRouteDevice reads the interface a route leaves by from %p', (route, dev) => {
  expect(parseRouteDevice(route, '93.184.216.34')).toBe(dev);
});

test('#parseRouteDevice rejects a route that names no interface', () => {
  expect(() =>
    parseRouteDevice('unreachable 203.0.113.9 table main', '203.0.113.9'),
  ).toThrowWithMessage(
    Error,
    'ip route get 203.0.113.9 named no interface: unreachable 203.0.113.9 table main',
  );
});

test('#readRouteDevice asks ip which interface a route to the address leaves by', async () => {
  const ip = buildStubIpCommand({
    outputs: {
      'ip route get 93.184.216.34': '93.184.216.34 via 172.17.0.1 dev eth0 src 172.17.0.2\n',
    },
  });

  const dev = await readRouteDevice('93.184.216.34', ip.runChecked);

  expect(dev).toBe('eth0');
});
