import { expect, mock, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildStubHostRoutes } from '../../../testing/host-net/build-stub-host-routes';
import { parseSubnet } from './addressing';
import { parsePrefix64 } from './addressing6';
import { NO_HOST_ROUTES, createReachPolicy } from './reach-policy';

function setupTest() {
  const prefix = parsePrefix64('fd12:3456:789a::/64');

  invariant(prefix);

  return { subnet: parseSubnet('10.66.0.0/16'), ipv6: { prefix, nat66: true, uplink: 'eth0' } };
}

test('it builds the ranges each imp and each public imp is refused', () => {
  const ctx = setupTest();

  const reach = createReachPolicy({
    subnet: parseSubnet('44.66.0.0/16'),
    deny: ['198.51.100.7/32', '2001:db8:9::/48'],
    ipv6: ctx.ipv6,
    now: () => 0,
    ...buildStubHostRoutes().deps,
  });

  const ranges = reach.buildRanges({
    connected4: ['172.17.0.0/16'],
    connected6: ['2001:db8:a::/64'],
    uplinks: { ipv4: ['eth0'], ipv6: [] },
  });

  expect(ranges.private4.at(-1)).toBe('44.66.0.0/16');
  expect(ranges.blocked6.slice(-2)).toStrictEqual(['fd12:3456:789a::/64', '2001:db8:a::/64']);

  expect(ranges.public4.slice(-3)).toStrictEqual([
    '44.66.0.0/16',
    '172.17.0.0/16',
    '198.51.100.7/32',
  ]);

  expect(ranges.public6.at(-1)).toBe('2001:db8:9::/48');
});

test.each([
  ['127.0.0.1', 'loopback', true],
  ['0.0.0.0', 'this network', true],
  ['169.254.169.254', "link-local, a cloud's metadata service", true],
  ['100.101.102.103', 'shared address space, the tailnet', true],
  ['239.1.2.3', 'multicast', true],
  ['255.255.255.255', 'broadcast', true],
  ['198.51.100.9', 'documentation', true],
  ['fd12:3456:789a::a42:6', "the imps' IPv6 prefix", true],
  ['fd00:ec2::254', "a cloud's metadata service", true],
  ['64:ff9b::a9fe:a9fe', 'NAT64', true],
  ['2001:db8:a::9', 'a connected IPv6 network', true],
  ['::ffff:127.0.0.1', 'a mapped loopback', true],
  ['example.com', 'a name', true],
  ['140.82.112.3', 'a public IPv4 address', false],
  ['172.32.0.1', 'a public IPv4 address beside a private block', false],
  ['2606:4700::1111', 'a public IPv6 address', false],
  ['2001:db8:b::1', 'an IPv6 documentation address', false],
])('it holds %s, %s, refused to an imp: %p', async (address, _label, refused) => {
  const ctx = setupTest();
  const routes = buildStubHostRoutes({ connected6: ['2001:db8:a::/64'] });

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: ctx.ipv6,
    now: () => 0,
    ...routes.deps,
  });

  const host = await reach.read(false);

  expect(host.isRefused(address, false)).toBe(refused);
});

test.each([
  ['172.17.0.9', 'a connected IPv4 network', true],
  ['198.51.100.7', 'an address the deny list holds', true],
  ['2001:db8:b::1', 'an IPv6 documentation address', true],
  ['2001:4::1', 'a reserved IPv6 address', true],
  ['140.82.112.3', 'a public IPv4 address', false],
  ['2606:4700::1111', 'a public IPv6 address', false],
])('it holds %s, %s, refused to a public imp: %p', async (address, _label, refused) => {
  const ctx = setupTest();
  const routes = buildStubHostRoutes({ connected4: ['172.17.0.0/16'] });

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: ['198.51.100.7'],
    ipv6: ctx.ipv6,
    now: () => 0,
    ...routes.deps,
  });

  const host = await reach.read(true);

  expect(host.isRefused(address, true)).toBe(refused);
});

test('it refuses every IPv6 address to an imp when impd has no IPv6 plan', async () => {
  const ctx = setupTest();

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: null,
    now: () => 0,
    ...buildStubHostRoutes().deps,
  });

  const host = await reach.read(false);

  expect(host.isRefused('2606:4700::1111', false)).toBeTrue();
});

test("it reads the host's uplinks for a public imp", async () => {
  const ctx = setupTest();
  const routes = buildStubHostRoutes({ uplinks: { ipv4: ['eth0'], ipv6: ['eth1'] } });

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: ctx.ipv6,
    now: () => 0,
    ...routes.deps,
  });

  const host = await reach.read(true);

  expect(host.uplinks).toStrictEqual({ ipv4: ['eth0'], ipv6: ['eth1'] });
});

test('it reads none of the IPv4 routes for imps that are not public', async () => {
  const ctx = setupTest();
  const readConnected4 = mock(() => Promise.resolve(['172.17.0.0/16']));
  const readUplinks = mock(() => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }));

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: null,
    now: () => 0,
    readConnected6: () => Promise.resolve([]),
    readConnected4,
    readUplinks,
  });

  const host = await reach.read(false);

  expect(host.uplinks).toStrictEqual(NO_HOST_ROUTES.uplinks);
  expect(readConnected4).not.toHaveBeenCalled();
  expect(readUplinks).not.toHaveBeenCalled();
});

test('it fails a read when a route read fails', () => {
  const ctx = setupTest();
  const routes = buildStubHostRoutes();

  routes.failUplinks('ip -4 route show default exited 1');

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: null,
    now: () => 0,
    ...routes.deps,
  });

  expect(reach.read(true)).rejects.toThrowWithMessage(Error, 'ip -4 route show default exited 1');
});

test('it answers a cached read from the last read within 30 s', async () => {
  const ctx = setupTest();
  const clock = { now: 0 };
  const readConnected6 = mock(() => Promise.resolve(['2001:db8:a::/64']));

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: ctx.ipv6,
    now: () => clock.now,
    ...buildStubHostRoutes().deps,
    readConnected6,
  });

  await reach.read(false);

  clock.now = 29_999;

  await reach.readCached(false);

  expect(readConnected6).toHaveBeenCalledTimes(1);
});

test('it reads the host again for a cached read 30 s after the last read', async () => {
  const ctx = setupTest();
  const clock = { now: 0 };
  const readConnected6 = mock(() => Promise.resolve(['2001:db8:a::/64']));

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: ctx.ipv6,
    now: () => clock.now,
    ...buildStubHostRoutes().deps,
    readConnected6,
  });

  await reach.read(false);

  clock.now = 30_000;

  await reach.readCached(false);

  expect(readConnected6).toHaveBeenCalledTimes(2);
});

test('it reads the host again for a public imp after a read for imps that are not public', async () => {
  const ctx = setupTest();
  const routes = buildStubHostRoutes({ connected4: ['172.17.0.0/16'] });

  const reach = createReachPolicy({
    subnet: ctx.subnet,
    deny: [],
    ipv6: ctx.ipv6,
    now: () => 0,
    ...routes.deps,
  });

  await reach.read(false);

  const host = await reach.readCached(true);

  expect(host.isRefused('172.17.0.9', true)).toBeTrue();
});
