import { IPv4 } from 'ipaddr.js';
import type { IPv6 } from 'ipaddr.js';
import { parseAddress } from './parse-address';

export interface Cidr {
  readonly address: IPv4 | IPv6;
  readonly bits: number;
}

export function parseCidr(text: string): Cidr | null {
  const [addressText = '', prefix, ...rest] = text.split('/');
  const address = parseAddress(addressText);

  if (address === null || rest.length > 0 || (prefix !== undefined && !/^\d{1,3}$/v.test(prefix))) {
    return null;
  }

  const maxBits = address instanceof IPv4 ? 32 : 128;
  const bits = prefix === undefined ? maxBits : Number(prefix);

  return bits > maxBits ? null : { address, bits };
}
