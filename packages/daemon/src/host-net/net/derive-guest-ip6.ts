import { IPv6 } from 'ipaddr.js';
import { parseAddress } from './parse-address';
import { parseCidr } from './parse-cidr';

const GROUPS = 8;
const GROUP_BITS = 16n;
const PREFIX_LENGTH = 64;

export const GATEWAY_IP6 = 'fe80::1';

export interface Prefix64 {
  readonly network: bigint;

  readonly text: string;
}

export function parseIpv6(text: string): bigint | null {
  const address = parseAddress(text);

  return address instanceof IPv6 ? toBigint(address) : null;
}

export function formatIpv6(address: bigint): string {
  const groups = Array.from({ length: GROUPS }, (_, index) =>
    Number((address >> (GROUP_BITS * BigInt(GROUPS - 1 - index))) & 0xff_ffn),
  );

  return new IPv6(groups).toRFC5952String();
}

export function formatCidr6(text: string): string | null {
  const parsed = parseCidr(text);

  if (parsed === null || !(parsed.address instanceof IPv6)) {
    return null;
  }

  const hostBits = BigInt(128 - parsed.bits);
  const network = (toBigint(parsed.address) >> hostBits) << hostBits;

  return `${formatIpv6(network)}/${String(parsed.bits)}`;
}

export function parsePrefix64(cidr: string): Prefix64 | null {
  const parsed = parseCidr(cidr);
  const network = parsed?.address instanceof IPv6 ? toBigint(parsed.address) : null;

  if (
    network === null ||
    !cidr.endsWith(`/${String(PREFIX_LENGTH)}`) ||
    network % 2n ** 64n !== 0n
  ) {
    return null;
  }

  return { network, text: `${formatIpv6(network)}/${String(PREFIX_LENGTH)}` };
}

export function buildUlaPrefix(random: Uint8Array): Prefix64 {
  if (random.length < 5) {
    throw new Error('a ULA global ID needs 5 random bytes');
  }

  const globalId = [...random.subarray(0, 5)].reduce((acc, byte) => (acc << 8n) + BigInt(byte), 0n);
  const network = ((0xfdn << 40n) + globalId) << 80n;

  return { network, text: `${formatIpv6(network)}/${String(PREFIX_LENGTH)}` };
}

export function findMappedIpv4(address: string): string | null {
  const parsed = parseAddress(address);

  return parsed instanceof IPv6 && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address().toString()
    : null;
}

export function deriveGuestIp6(prefix: Readonly<Prefix64>, guestIpv4: number): string {
  return formatIpv6(prefix.network + BigInt(guestIpv4));
}

function toBigint(address: IPv6): bigint {
  return address.parts.reduce((acc, group) => (acc << GROUP_BITS) + BigInt(group), 0n);
}
