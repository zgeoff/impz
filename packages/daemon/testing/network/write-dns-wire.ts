// DNS wire format as RFC 1035 lays it out, for the mock messages: type codes
// (RFC 3596 for AAAA), names without compression, and 16-bit fields.

export const DNS_TYPE_CODES = {
  // oxlint-disable-next-line id-length -- `A` is the record type's name in RFC 1035
  A: 1,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
} as const;

export const DNS_CLASS_IN = 1;

export function encodeDnsName(name: string): number[] {
  const labels = name.split('.').filter((label) => label !== '');
  const bytes: number[] = [];

  for (const label of labels) {
    bytes.push(label.length, ...new TextEncoder().encode(label));
  }

  bytes.push(0);

  return bytes;
}

export function encodeDnsUint16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}
