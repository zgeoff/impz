import { formatSubnet } from './addressing';
import type { Subnet } from './addressing';
import { readConnectedPrefixes, readUplinks } from './host-routes';
import type { Uplinks } from './host-routes';
import type { Ipv6Plan } from './ipv6-plan';
import { parseAddress } from './parse-address';
import { buildRangeMatcher } from './range-matcher';
import {
  BLOCKED_RANGES6,
  DOCUMENTATION_RANGES6,
  REFUSED_RANGES4,
  RESERVED_RANGES6,
} from './ranges';

const HOST_ROUTES_TTL_MS = 30_000;

export interface ReachBoundaries {
  readonly readConnected4: () => Promise<readonly string[]>;
  readonly readConnected6: () => Promise<readonly string[]>;
  readonly readUplinks: () => Promise<Uplinks>;
}

export interface ReachPolicyOptions extends Partial<ReachBoundaries> {
  readonly subnet: Subnet;
  readonly deny: readonly string[];
  readonly ipv6: Ipv6Plan | null;
  readonly now: () => number;
}

export interface HostRoutes {
  readonly connected4: readonly string[];
  readonly connected6: readonly string[];
  readonly uplinks: Uplinks;
}

export interface ReachRanges {
  readonly private4: readonly string[];
  readonly blocked6: readonly string[];
  readonly public4: readonly string[];
  readonly public6: readonly string[];
}

interface HostReach {
  readonly ranges: ReachRanges;
  readonly uplinks: Uplinks;

  readonly isRefused: (address: string, isPublic: boolean) => boolean;
}

export interface ReachPolicy {
  readonly hasIPv6: boolean;

  readonly buildRanges: (routes: Readonly<HostRoutes>) => ReachRanges;

  readonly read: (hasPublic: boolean) => Promise<HostReach>;

  readonly readCached: (isPublic: boolean) => Promise<HostReach>;
}

export const NO_HOST_ROUTES: HostRoutes = {
  connected4: [],
  connected6: [],
  uplinks: { ipv4: [], ipv6: [] },
};

export function createReachPolicy(options: ReachPolicyOptions): ReachPolicy {
  const readers: ReachBoundaries = {
    readConnected4: options.readConnected4 ?? (() => readConnectedPrefixes('ipv4')),
    readConnected6: options.readConnected6 ?? (() => readConnectedPrefixes('ipv6')),
    readUplinks: options.readUplinks ?? (() => readUplinks()),
  };

  const hasIPv6 = options.ipv6 !== null;
  const private4 = [...REFUSED_RANGES4, formatSubnet(options.subnet)];
  const deny4 = options.deny.filter((cidr) => !cidr.includes(':'));
  const deny6 = options.deny.filter((cidr) => cidr.includes(':'));

  const buildRanges = (routes: Readonly<HostRoutes>): ReachRanges => {
    const blocked6 = [
      ...BLOCKED_RANGES6,
      ...(options.ipv6 === null ? [] : [options.ipv6.prefix.text]),
      ...routes.connected6,
    ];

    return {
      private4,
      blocked6,
      public4: [...private4, ...routes.connected4, ...deny4],
      public6: [...blocked6, ...DOCUMENTATION_RANGES6, ...RESERVED_RANGES6, ...deny6],
    };
  };

  const cache: { reach: HostReach | null; hasPublic: boolean; at: number } = {
    reach: null,
    hasPublic: false,
    at: 0,
  };

  // read at each call: Docker can attach a network to the container later
  const read = async (hasPublic: boolean): Promise<HostReach> => {
    const routes: HostRoutes = {
      connected6: hasIPv6 ? await readers.readConnected6() : [],
      connected4: hasPublic ? await readers.readConnected4() : [],
      uplinks: hasPublic ? await readers.readUplinks() : NO_HOST_ROUTES.uplinks,
    };

    const reach = buildHostReach(buildRanges(routes), routes.uplinks, hasIPv6);

    Object.assign(cache, { reach, hasPublic, at: options.now() });

    return reach;
  };

  return {
    hasIPv6,
    buildRanges,
    read,
    readCached: (isPublic) => {
      const isFresh = options.now() - cache.at < HOST_ROUTES_TTL_MS;

      return cache.reach !== null && isFresh && (cache.hasPublic || !isPublic)
        ? Promise.resolve(cache.reach)
        : read(isPublic);
    },
  };
}

function buildHostReach(ranges: ReachRanges, uplinks: Uplinks, hasIPv6: boolean): HostReach {
  const isPrivate = buildRangeMatcher([...ranges.private4, ...ranges.blocked6]);
  const isPublicRefused = buildRangeMatcher([...ranges.public4, ...ranges.public6]);

  return {
    ranges,
    uplinks,
    isRefused: (address, isPublic) => {
      const ip = parseAddress(address);

      if (ip === null || (!hasIPv6 && ip.kind() === 'ipv6')) {
        return true;
      }

      return isPublic ? isPublicRefused(address) : isPrivate(address);
    },
  };
}
