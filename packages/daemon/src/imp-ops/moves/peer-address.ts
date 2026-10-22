import { isIP } from 'node:net';
import { buildRangeMatcher } from '../../host-net/net/range-matcher';

const TAILNET_RANGES = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

export interface PeerRanges {
  readonly isAllowed: (address: string) => boolean;
  readonly testCidr: string | null;
}

export function buildPeerRanges(testCidr: string | null): PeerRanges {
  const ranges = testCidr === null ? TAILNET_RANGES : [...TAILNET_RANGES, testCidr];

  return { isAllowed: buildRangeMatcher(ranges), testCidr };
}

export function parsePeerUrlAddress(url: string): string | null {
  const host = new URL(url).hostname.replaceAll(/^\[|\]$/gu, '');

  // A host name is refused, because its DNS lookup could send the bytes off the
  // tailnet.
  return isIP(host) === 0 ? null : host;
}
