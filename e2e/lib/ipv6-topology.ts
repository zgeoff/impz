import { requireImp, runShellInImp } from './imp-cli';
import { instance, runChecked, runCommand, runDevScript, runInContainer } from './instance';

export interface V6Plan {
  readonly near: string;
  readonly far: string;
  readonly routed: string;
  readonly routerNear: string;
  readonly routerFar: string;

  readonly server: string;
  readonly serverOther: string;
}

// Three /64s of the documentation range per instance, so instances side by
// side never ask Docker for the same pool.
export function buildV6Plan(portOffset: number): V6Plan {
  const block = 0x6a + 3 * portOffset;
  const buildPrefix = (index: number) => `2001:db8:${(block + index).toString(16)}::`;
  const near = buildPrefix(0);
  const far = buildPrefix(1);

  return {
    near,
    far,
    routed: buildPrefix(2),
    routerNear: `${near}100`,
    routerFar: `${far}100`,
    server: `${far}200`,
    serverOther: `${far}201`,
  };
}

export function buildGuestIpv6(network: string, ipv4: string): string {
  const [firstOctet = 0, secondOctet = 0, thirdOctet = 0, fourthOctet = 0] = ipv4
    .split('.')
    .map(Number);

  return `${network}${((firstOctet << 8) | secondOctet).toString(16)}:${((thirdOctet << 8) | fourthOctet).toString(16)}`;
}

export function parseUlaNetwork(log: string): string {
  const found = /impd: ipv6: (?<network>fd[\da-f:]+::)\/64, NAT66/v.exec(log)?.groups?.['network'];

  if (found === undefined) {
    throw new TypeError(`impd logged no NAT66 prefix:\n${log}`);
  }

  return found;
}

export function parseGlobal128(addresses: string): string {
  const address = /inet6 (?<address>[\da-f:]+)\/128/v.exec(addresses)?.groups?.['address'];

  if (address === undefined) {
    throw new Error(`no global /128 in ${JSON.stringify(addresses)}`);
  }

  return address;
}

export function parseRsAccepts(listing: string): number {
  const line = listing
    .split('\n')
    .find((row) => row.includes('ACCEPT') && row.includes('imp+') && row.includes('icmptype 133'));

  if (line === undefined) {
    throw new Error('no RS ACCEPT rule for the taps in INPUT');
  }

  return Number(line.trim().split(/\s+/v)[0]);
}

export function buildRaCounterTable(prefix: string): string {
  return `${prefix}ra`;
}

// The netdev ingress hook counts before any inet hook can drop the packets.
export function buildRaCounterRuleset(table: string, tap: string): string {
  return [
    `table netdev ${table} {`,
    '  chain ingress {',
    `    type filter hook ingress device "${tap}" priority 0;`,
    '    icmpv6 type nd-router-advert counter',
    '    icmpv6 type nd-router-solicit counter',
    '  }',
    '}',
  ].join('\n');
}

export interface RaCounts {
  readonly adverts: number;
  readonly solicits: number;
}

export function parseRaCounts(listing: string): RaCounts {
  const getCount = (type: string) => {
    const match = new RegExp(String.raw`${type} counter packets (?<n>\d+)`, 'v').exec(listing);

    const count = match?.groups?.['n'];

    if (count === undefined) {
      throw new Error(`no ${type} counter in ${JSON.stringify(listing)}`);
    }

    return Number(count);
  };

  return { adverts: getCount('nd-router-advert'), solicits: getCount('nd-router-solicit') };
}

export function parseRouteDevice(route: string): string {
  return /\bdev (?<dev>\S+)/v.exec(route)?.groups?.['dev'] ?? '';
}

export interface V6Names {
  readonly near: string;
  readonly far: string;
  readonly router: string;
  readonly server: string;
}

export function buildV6Names(container: string): V6Names {
  return {
    near: `${container}-v6`,
    far: `${container}-v6far`,
    router: `${container}-v6-router`,
    server: `${container}-v6-server`,
  };
}

function buildServerScript(plan: Readonly<V6Plan>): string {
  // The server sends what fits the far network but asks for full segments, as a
  // server on a wider link would, so the guest's segments must shrink on the way.
  const wideMss = 'mtu 1280 advmss 1440';

  return [
    'mkdir -p /www/cgi-bin',
    'echo v6-ok > /www/index.html',
    'head -c 2097152 /dev/zero > /www/big',
    String.raw`printf '#!/bin/sh\necho Content-Type: text/plain\necho\necho $REMOTE_ADDR\n' > /www/cgi-bin/peer`,
    String.raw`printf '#!/bin/sh\necho Content-Type: text/plain\necho\nwc -c\n' > /www/cgi-bin/upload`,
    'chmod +x /www/cgi-bin/peer /www/cgi-bin/upload',
    `ip -6 addr add ${plan.serverOther}/64 dev eth0`,
    `ip -6 route add ${plan.near}/64 via ${plan.routerFar} ${wideMss}`,
    `ip -6 route add ${plan.routed}/64 via ${plan.routerFar} ${wideMss}`,

    'httpd -p [::]:53 -h /www',
    'exec httpd -f -p [::]:80 -h /www',
  ].join(' && ');
}

// Docker drops what is routed to a container from another bridge, which is
// the router's whole job here; unprotected lets it through.
const CREATE_NETWORK = [
  'docker',
  'network',
  'create',
  '--ipv6',
  '-o',
  'com.docker.network.bridge.gateway_mode_ipv6=nat-unprotected',
];

export async function stopV6Topology(): Promise<void> {
  const names = buildV6Names(instance.container);

  await runCommand(['docker', 'network', 'disconnect', '-f', names.near, instance.container]);
  await runCommand(['docker', 'rm', '-f', names.router, names.server]);
  await runCommand(['docker', 'network', 'rm', names.near, names.far]);
}

export async function startV6Topology(plan: Readonly<V6Plan>): Promise<void> {
  const names = buildV6Names(instance.container);

  await stopV6Topology();
  await runChecked([...CREATE_NETWORK, '--subnet', `${plan.near}/64`, names.near]);

  await runChecked([
    ...CREATE_NETWORK,
    '--subnet',
    `${plan.far}/64`,
    '-o',
    'com.docker.network.driver.mtu=1280',
    names.far,
  ]);

  await runChecked([
    'docker',
    'create',
    '--name',
    names.router,
    '--network',
    names.near,
    '--ip6',
    plan.routerNear,
    '--cap-add',
    'NET_ADMIN',
    '--sysctl',
    'net.ipv6.conf.all.forwarding=1',
    'busybox:1.37',
    'sleep',
    'infinity',
  ]);

  await runChecked([
    'docker',
    'network',
    'connect',
    '--ip6',
    plan.routerFar,
    names.far,
    names.router,
  ]);

  await runChecked(['docker', 'start', names.router]);

  await runChecked([
    'docker',
    'run',
    '-d',
    '--name',
    names.server,
    '--network',
    names.far,
    '--ip6',
    plan.server,
    '--cap-add',
    'NET_ADMIN',
    'busybox:1.37',
    'sh',
    '-c',
    buildServerScript(plan),
  ]);
}

export async function readV6HostAddress(): Promise<string> {
  const names = buildV6Names(instance.container);

  const address = await runChecked([
    'docker',
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${names.near}").GlobalIPv6Address}}`,
    instance.container,
  ]);

  return address.trim();
}

export async function startV6Instance(plan: Readonly<V6Plan>, subnet6: string): Promise<void> {
  await runDevScript('reboot', instance, {
    IMP_DEV_NETWORK: buildV6Names(instance.container).near,

    // Wider than the far network, so only packet-too-big gets a full segment through.
    IMP_UPLINK_MTU: '1500',
    IMP_SUBNET6: subnet6,
  });

  await runInContainer(['ip', '-6', 'route', 'replace', `${plan.far}/64`, 'via', plan.routerNear]);
}

export async function readGuestIpv6(name: string): Promise<string> {
  const addresses = await runShellInImp(name, 'ip -6 addr show dev eth0 scope global');

  return parseGlobal128(addresses);
}

export async function readRsAccepts(): Promise<number> {
  const result = await runInContainer(['ip6tables', '-w', '-vnxL', 'INPUT']);

  return parseRsAccepts(result.stdout);
}

export async function readImpTap(name: string): Promise<string> {
  const row = await requireImp(name);
  const route = await runInContainer(['ip', '-o', 'route', 'get', row.ip]);

  return parseRouteDevice(route.stdout);
}

export async function startRaCounter(table: string, tap: string): Promise<void> {
  const listed = await runInContainer(['nft', 'list', 'table', 'netdev', table]);

  if (listed.exitCode === 0) {
    throw new Error(`nft table netdev ${table} is already there`);
  }

  const result = await runCommand(['docker', 'exec', '-i', instance.container, 'nft', '-f', '-'], {
    stdin: buildRaCounterRuleset(table, tap),
  });

  if (result.exitCode !== 0) {
    throw new Error(`nft -f - exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

export async function stopRaCounter(table: string): Promise<void> {
  await runInContainer(['nft', 'delete', 'table', 'netdev', table]);
}

export async function readRaCounts(table: string): Promise<RaCounts> {
  const result = await runInContainer(['nft', 'list', 'table', 'netdev', table]);

  if (result.exitCode !== 0) {
    throw new Error(`nft list table netdev ${table}: ${result.stderr.trim()}`);
  }

  return parseRaCounts(result.stdout);
}

export async function readHostRouting(): Promise<string> {
  const result = await runInContainer([
    'sh',
    '-c',
    'ip -6 route; ip -6 addr show scope global; sysctl net.ipv6.conf.all.accept_ra net.ipv6.conf.default.accept_ra',
  ]);

  return result.stdout;
}
