import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { parseIpv4 } from '../../host-net/net/addressing';
import { formatIpv6, parseIpv6 } from '../../host-net/net/addressing6';
import { findMappedIpv4 } from '../../host-net/net/ranges6';
import { getErrorMessage } from '../../platform/process/get-error-message';

// Where a plain tunnel may go. It starts in the host container, past the
// `INPUT -i imp+ DROP` rule: unchecked, a guest could reach impd's API, the
// wake proxy and other imps' ports.

// every block the IANA IPv4 Special-Purpose Address Registry marks not
// globally reachable, and multicast
export const REFUSED_RANGES: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const PARSED_RANGES = REFUSED_RANGES.map(([network, prefix]) => {
  const parsed = parseIpv4(network);

  if (parsed === null) {
    throw new Error(`bad range ${network}`);
  }

  return { network: parsed, size: 2 ** (32 - prefix) };
});

export class TunnelRefusedError extends Error {
  override name = 'TunnelRefusedError';
}

export function isRefusedAddress(
  address: string,
  hostAddresses: ReadonlySet<string>,
  isBlocked6: ((address: string) => boolean) | null = null,
): boolean {
  const hostKeys = new Set([...hostAddresses].map((host) => formatAddressKey(host)));

  const mapped = findMappedIpv4(address);

  if (hostKeys.has(formatAddressKey(mapped ?? address))) {
    return true;
  }

  const ip = parseIpv4(mapped ?? address);

  if (ip === null) {
    return isBlocked6 === null || parseIpv6(address) === null || isBlocked6(address);
  }

  return PARSED_RANGES.some((range) => ip >= range.network && ip < range.network + range.size);
}

function formatAddressKey(address: string): string {
  const ip4 = parseIpv4(address);
  const ip6 = parseIpv6(address);

  if (ip4 !== null) {
    return String(ip4);
  }

  return ip6 === null ? address.toLowerCase() : formatIpv6(ip6);
}

// every address on the host's interfaces, read at call time: tailscaled can
// add one after impd starts
function readHostAddresses(): ReadonlySet<string> {
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((entry) => entry.address);

  return new Set(addresses);
}

export interface TunnelTargetDeps {
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly readHostAddresses?: () => ReadonlySet<string>;

  readonly isBlocked6?: ((address: string) => boolean) | null;

  readonly isRefusedMore?: (address: string) => boolean;
}

export async function resolveTunnelTarget(
  host: string,
  deps: TunnelTargetDeps = {},
): Promise<string> {
  const isBlocked6 = deps.isBlocked6 ?? null;
  const resolve = deps.resolve ?? ((name: string) => resolveAddresses(name, isBlocked6 !== null));
  const hostAddresses = (deps.readHostAddresses ?? readHostAddresses)();

  // resolved once and dialled as checked, so a DNS rebind cannot swap the address
  const answers = await resolve(host);

  const addresses = answers.map((address) => findMappedIpv4(address) ?? address);

  const [first] = [
    ...addresses.filter((address) => parseIpv4(address) !== null),
    ...addresses.filter((address) => parseIpv4(address) === null),
  ];

  if (first === undefined) {
    throw new TunnelRefusedError(`${host} has no address a tunnel may dial`);
  }

  const isRefusedMore = deps.isRefusedMore ?? (() => false);

  const refused = addresses.find(
    (address) => isRefusedAddress(address, hostAddresses, isBlocked6) || isRefusedMore(address),
  );

  if (refused !== undefined) {
    throw new TunnelRefusedError(`${host} resolves to ${refused}, which a tunnel may not reach`);
  }

  return first;
}

export async function requireUplinkRoute(
  host: string,
  address: string,
  uplinks: Readonly<{ ipv4: readonly string[]; ipv6: readonly string[] }>,
  readRouteDevice: (address: string) => Promise<string>,
): Promise<void> {
  const allowed = parseIpv4(address) === null ? uplinks.ipv6 : uplinks.ipv4;
  let dev: string;

  try {
    dev = await readRouteDevice(address);
  } catch (error) {
    throw new TunnelRefusedError(`${host}: no route to ${address}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  if (!allowed.includes(dev)) {
    throw new TunnelRefusedError(
      `${host} resolves to ${address}, which the host reaches by ${dev}, not by a default route`,
    );
  }
}

async function resolveAddresses(host: string, ipv6: boolean): Promise<readonly string[]> {
  if (parseIpv4(host) !== null || host.includes(':')) {
    return [host];
  }

  const answers = await lookup(host, { all: true, family: ipv6 ? 0 : 4 });

  return answers.map((answer) => answer.address);
}
