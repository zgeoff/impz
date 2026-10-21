import { existsSync } from 'node:fs';
import { runChecked } from '../../platform/process/run-command';
import { formatCidr4 } from './addressing';

const NON_UNICAST = new Set([
  'local',
  'broadcast',
  'blackhole',
  'unreachable',
  'prohibit',
  'throw',
  'multicast',
  'anycast',
  'nat',
]);

type RunChecked = (argv: readonly string[]) => Promise<string>;

export async function readConnectedPrefixes4(
  run: RunChecked = runChecked,
): Promise<readonly string[]> {
  const routes = await run(['ip', '-4', 'route', 'show']);
  const addresses = await run(['ip', '-4', '-o', 'addr', 'show']);

  return parseConnectedPrefixes4(routes, addresses);
}

export function parseConnectedPrefixes4(routes: string, addresses: string): readonly string[] {
  const found = [
    ...routes.split('\n').flatMap((line) => {
      const words = line.trim().split(/\s+/v);
      const destination = (NON_UNICAST.has(words[0] ?? '') ? '' : words[0]) ?? '';
      const dev = /\bdev (?<dev>\S+)/v.exec(line)?.groups?.['dev'] ?? '';

      return line.includes(' via ') || dev.startsWith('imp') ? [] : [destination];
    }),
    ...addresses.split('\n').flatMap((line) => {
      const groups = /^\d+:\s+(?<dev>\S+)\s+inet\s+(?<cidr>\S+)/v.exec(line)?.groups ?? {};
      const dev = groups['dev'] ?? 'imp';
      const cidr = groups['cidr'] ?? '';

      return dev.startsWith('imp') || cidr === '' ? [] : [cidr, `${cidr.split('/')[0] ?? ''}/32`];
    }),
  ];

  const prefixes = new Set<string>();

  for (const text of found) {
    const prefix = formatCidr4(text);

    if (prefix !== null) {
      prefixes.add(prefix);
    }
  }

  return [...prefixes];
}

export interface Uplinks {
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
}

export async function readUplinks(
  procNet = '/proc/sys/net/ipv6',
  run: RunChecked = runChecked,
): Promise<Uplinks> {
  const ipv4 = await run(['ip', '-4', 'route', 'show', 'default']);

  const ipv6 = existsSync(procNet) ? await run(['ip', '-6', 'route', 'show', 'default']) : '';

  return { ipv4: parseUplinks(ipv4), ipv6: parseUplinks(ipv6) };
}

export function parseUplinks(routes: string): readonly string[] {
  let isDefault = false;

  const devs = routes.split('\n').flatMap((line) => {
    // ip names a multipath route's interfaces on the indented `nexthop` lines
    // under it, not on its own line
    if (!/^\s/v.test(line)) {
      isDefault = line.startsWith('default');
    }

    const dev = /\bdev (?<dev>\S+)/v.exec(line)?.groups?.['dev'];

    return isDefault && dev !== undefined && !dev.startsWith('imp') ? [dev] : [];
  });

  return [...new Set(devs)];
}

export async function readRouteDevice(
  address: string,
  run: RunChecked = runChecked,
): Promise<string> {
  const route = await run(['ip', 'route', 'get', address]);

  return parseRouteDevice(route, address);
}

export function parseRouteDevice(route: string, address: string): string {
  const dev = /\bdev (?<dev>\S+)/v.exec(route)?.groups?.['dev'];

  if (dev === undefined) {
    throw new Error(`ip route get ${address} named no interface: ${route.trim()}`);
  }

  return dev;
}
