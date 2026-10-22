import { IPv4 } from 'ipaddr.js';
import { deriveGuestIp6 } from './addressing6';
import type { Prefix64 } from './addressing6';
import { parseAddress } from './parse-address';
import { parseCidr } from './parse-cidr';

const SLOT_SIZE = 4;
const SLOT_PREFIX_LENGTH = 30;

export interface Subnet {
  readonly network: number;
  readonly prefixLength: number;
}

export interface SlotAddress {
  readonly slot: number;
  readonly tap: string;
  readonly hostIp: string;
  readonly guestIp: string;
  readonly prefixLength: number;
  readonly netmask: string;
  readonly guestMac: string;

  readonly hostMac: string;

  readonly guestIp6: string | null;

  readonly tailnetPort: number;
}

export interface SlotPlan {
  readonly subnet: Subnet;
  readonly portBase: number;
  readonly prefix6?: Prefix64 | null;
}

export function parseSubnet(cidr: string): Subnet {
  const parsed = cidr.includes('/') ? parseCidr(cidr) : null;

  if (parsed === null || !(parsed.address instanceof IPv4)) {
    throw new Error(`subnet is not an IPv4 CIDR: ${cidr}`);
  }

  if (parsed.bits < 8 || parsed.bits > SLOT_PREFIX_LENGTH) {
    throw new Error(`subnet prefix must be between /8 and /30: ${cidr}`);
  }

  const network = toNumber(parsed.address);

  if (network % 2 ** (32 - parsed.bits) !== 0) {
    throw new Error(`subnet has host bits set: ${cidr}`);
  }

  return { network, prefixLength: parsed.bits };
}

// Tailscale's 100.64.0.0/10: a guest with an address in it would look like
// a tailnet peer to impd's tailnet identity
const TAILNET_NETWORK = 100 * 2 ** 24 + 64 * 2 ** 16;
const TAILNET_SIZE = 2 ** 22;

export function isTailnetOverlap(subnet: Subnet): boolean {
  const start = subnet.network;
  const end = start + 2 ** (32 - subnet.prefixLength);

  return start < TAILNET_NETWORK + TAILNET_SIZE && TAILNET_NETWORK < end;
}

export function countSlots(subnet: Subnet): number {
  return 2 ** (32 - subnet.prefixLength) / SLOT_SIZE;
}

export function deriveSlotAddress(slot: number, plan: SlotPlan): SlotAddress {
  if (!Number.isInteger(slot) || slot < 0 || slot >= countSlots(plan.subnet)) {
    throw new RangeError(`slot ${String(slot)} is outside the subnet`);
  }

  const base = plan.subnet.network + slot * SLOT_SIZE;
  const guest = base + 2;

  return {
    slot,
    tap: `imp${String(slot)}`,
    hostIp: formatIpv4(base + 1),
    guestIp: formatIpv4(guest),
    prefixLength: SLOT_PREFIX_LENGTH,
    netmask: '255.255.255.252',

    // 06 is a locally administered unicast prefix, then the guest IP: unique per
    // slot and readable in a packet capture
    guestMac: ['06', '00', ...splitOctets(guest).map((octet) => toHexByte(octet))].join(':'),
    hostMac: ['06', '01', ...splitOctets(base + 1).map((octet) => toHexByte(octet))].join(':'),
    guestIp6:
      plan.prefix6 === undefined || plan.prefix6 === null
        ? null
        : deriveGuestIp6(plan.prefix6, guest),
    tailnetPort: plan.portBase + slot,
  };
}

export function parseIpv4(text: string, allowMapped = false): number | null {
  const address = parseAddress(text);

  if (address instanceof IPv4) {
    return toNumber(address);
  }

  // Node writes an IPv4 peer of a dual-stack socket as ::ffff:a.b.c.d
  return allowMapped && address?.isIPv4MappedAddress() === true
    ? toNumber(address.toIPv4Address())
    : null;
}

export function findPeerSlot(peer: string, local: string, subnet: Subnet): number | null {
  const peerIp = parseIpv4(peer, true);
  const localIp = parseIpv4(local, true);

  if (peerIp === null || localIp === null) {
    return null;
  }

  const offset = peerIp - subnet.network;

  if (offset < 0 || offset >= 2 ** (32 - subnet.prefixLength) || offset % SLOT_SIZE !== 2) {
    return null;
  }

  return localIp === peerIp - 1 ? (offset - 2) / SLOT_SIZE : null;
}

export function findGuestSlot(address: string, subnet: Subnet): number | null {
  const ip = parseIpv4(address, true);
  const offset = ip === null ? -1 : ip - subnet.network;

  if (offset < 0 || offset >= 2 ** (32 - subnet.prefixLength) || offset % SLOT_SIZE !== 2) {
    return null;
  }

  return (offset - 2) / SLOT_SIZE;
}

export function formatSubnet(subnet: Subnet): string {
  return `${formatIpv4(subnet.network)}/${String(subnet.prefixLength)}`;
}

export function formatCidr4(text: string): string | null {
  const parsed = parseCidr(text);

  if (parsed === null || !(parsed.address instanceof IPv4)) {
    return null;
  }

  const ip = toNumber(parsed.address);

  return formatSubnet({ network: ip - (ip % 2 ** (32 - parsed.bits)), prefixLength: parsed.bits });
}

function toNumber(address: IPv4): number {
  return address.octets.reduce((acc, octet) => acc * 256 + octet, 0);
}

function formatIpv4(address: number): string {
  return splitOctets(address).join('.');
}

function splitOctets(address: number): readonly number[] {
  return [
    Math.floor(address / 2 ** 24) % 256,
    Math.floor(address / 2 ** 16) % 256,
    Math.floor(address / 2 ** 8) % 256,
    address % 256,
  ];
}

function toHexByte(octet: number): string {
  return octet.toString(16).padStart(2, '0');
}
