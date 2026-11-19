import { IPv4 } from 'ipaddr.js';
import type { IPv6 } from 'ipaddr.js';
import { parseAddress } from './parse-address';
import { parseCidr } from './parse-cidr';

export function buildRangeMatcher(ranges: readonly string[]): (address: string) => boolean {
  const ranges4: (readonly [IPv4, number])[] = [];
  const ranges6: (readonly [IPv6, number])[] = [];

  for (const range of ranges) {
    const cidr = parseCidr(range);

    if (cidr === null) {
      throw new Error(`not an address range: ${range}`);
    }

    if (cidr.address instanceof IPv4) {
      ranges4.push([cidr.address, cidr.bits]);
    } else {
      ranges6.push([cidr.address, cidr.bits]);
    }
  }

  const isIn4 = (ip: IPv4): boolean => ranges4.some(([network, bits]) => ip.match(network, bits));
  const isIn6 = (ip: IPv6): boolean => ranges6.some(([network, bits]) => ip.match(network, bits));

  return (address) => {
    const ip = parseAddress(address);

    if (ip === null) {
      return false;
    }

    if (ip instanceof IPv4) {
      return isIn4(ip);
    }

    // a mapped address reaches the IPv4 host it carries
    return isIn6(ip) || (ip.isIPv4MappedAddress() && isIn4(ip.toIPv4Address()));
  };
}
