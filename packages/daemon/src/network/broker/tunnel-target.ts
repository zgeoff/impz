import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { parseIpv4 } from '../../host-net/net/addressing';
import { findMappedIpv4, formatIpv6, parseIpv6 } from '../../host-net/net/addressing6';
import { getErrorMessage } from '../../platform/process/get-error-message';

// A plain tunnel starts in the host container, past the `INPUT -i imp+ DROP`
// rule: unchecked, a guest could reach impd's API, the wake proxy and other
// imps' ports.

export class TunnelRefusedError extends Error {
  override name = 'TunnelRefusedError';
}

/* @internal */
export function isRefusedAddress(
  address: string,
  hostAddresses: ReadonlySet<string>,
  isRefused: (address: string) => boolean,
): boolean {
  const hostKeys = new Set([...hostAddresses].map((host) => formatAddressKey(host)));

  const plain = findMappedIpv4(address) ?? address;

  return hostKeys.has(formatAddressKey(plain)) || isRefused(plain);
}

function formatAddressKey(address: string): string {
  const ip4 = parseIpv4(address);
  const ip6 = parseIpv6(address);

  if (ip4 !== null) {
    return String(ip4);
  }

  return ip6 === null ? address.toLowerCase() : formatIpv6(ip6);
}

// read at call time: tailscaled can add an address after impd starts
function readHostAddresses(): ReadonlySet<string> {
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((entry) => entry.address);

  return new Set(addresses);
}

export interface TunnelTargetDeps {
  readonly isRefused: (address: string) => boolean;
  readonly hasIPv6: boolean;

  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly readHostAddresses?: () => ReadonlySet<string>;
}

export async function resolveTunnelTarget(host: string, deps: TunnelTargetDeps): Promise<string> {
  const resolve = deps.resolve ?? ((name: string) => resolveAddresses(name, deps.hasIPv6));
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

  const refused = addresses.find((address) =>
    isRefusedAddress(address, hostAddresses, deps.isRefused),
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
