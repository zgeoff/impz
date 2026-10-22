import { existsSync } from 'node:fs';
import { runChecked, runCommand } from '../../platform/process/run-command';
import type { CommandRunner } from '../../platform/process/run-command';
import { formatCidr4 } from './addressing';
import { formatCidr6 } from './addressing6';

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

export type IpFamily = 'ipv4' | 'ipv6';

// A failed read throws: a blocklist without these prefixes would let an imp
// or a tunnel reach them.
export async function readConnectedPrefixes(
  family: IpFamily,
  run: RunChecked = runChecked,
): Promise<readonly string[]> {
  const flag = family === 'ipv4' ? '-4' : '-6';

  const routes = await run(['ip', flag, 'route', 'show']);
  const addresses = await run(['ip', flag, '-o', 'addr', 'show']);

  return parseConnectedPrefixes(family, routes, addresses);
}

/* @internal */
export function parseConnectedPrefixes(
  family: IpFamily,
  routes: string,
  addresses: string,
): readonly string[] {
  const found = [
    ...routes.split('\n').flatMap((line) => {
      const words = line.trim().split(/\s+/v);
      const destination = (NON_UNICAST.has(words[0] ?? '') ? '' : words[0]) ?? '';
      const dev = /\bdev (?<dev>\S+)/v.exec(line)?.groups?.['dev'] ?? '';

      return line.includes(' via ') || dev.startsWith('imp') ? [] : [destination];
    }),
    ...addresses.split('\n').flatMap((line) => {
      const groups =
        /^\d+:\s+(?<dev>\S+)\s+inet6?\s+(?<cidr>\S+)(?:.*?\sscope\s+(?<scope>\S+))?/v.exec(line)
          ?.groups ?? {};

      const dev = groups['dev'] ?? 'imp';
      const cidr = groups['cidr'] ?? '';

      if (dev.startsWith('imp') || cidr === '') {
        return [];
      }

      // an IPv4 address of the host is refused on its own as well: a /32 such
      // as tailscale's comes with no route
      if (family === 'ipv4') {
        return [cidr, `${cidr.split('/')[0] ?? ''}/32`];
      }

      return groups['scope'] === 'global' ? [cidr] : [];
    }),
  ];

  const prefixes = new Set<string>();

  for (const text of found) {
    const prefix = family === 'ipv4' ? formatCidr4(text) : formatCidr6(text);
    const isLocalOnly = prefix?.startsWith('fe80:') === true || prefix?.startsWith('ff') === true;

    if (prefix !== null && !isLocalOnly) {
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

export async function readIpv6DefaultRoute(
  run: CommandRunner = runCommand,
): Promise<string | null> {
  const result = await run(['ip', '-6', 'route', 'show', 'default']);

  return result.exitCode === 0 ? (parseUplinks(result.stdout)[0] ?? null) : null;
}

/* @internal */
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

/* @internal */
export function parseRouteDevice(route: string, address: string): string {
  const dev = /\bdev (?<dev>\S+)/v.exec(route)?.groups?.['dev'];

  if (dev === undefined) {
    throw new Error(`ip route get ${address} named no interface: ${route.trim()}`);
  }

  return dev;
}
