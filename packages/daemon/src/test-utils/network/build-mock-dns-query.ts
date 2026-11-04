import { faker } from '@faker-js/faker';
import { DNS_CLASS_IN, DNS_TYPE_CODES, encodeDnsName, encodeDnsUint16 } from './write-dns-wire';

const TYPE_OPT = 41;
const RD = 0x01_00;

interface MockDnsQuery {
  readonly name: string;
  readonly type: keyof typeof DNS_TYPE_CODES;
  readonly id: number;
  readonly edns: boolean;
}

export function buildMockDnsQuery(
  query: Readonly<Pick<MockDnsQuery, 'name' | 'type'> & Partial<MockDnsQuery>>,
): Uint8Array {
  const id = query.id ?? faker.number.int({ min: 0, max: 0xff_ff });
  const edns = query.edns ?? true;
  const additionals = edns ? 1 : 0;

  return Uint8Array.from([
    ...encodeDnsUint16(id),
    ...encodeDnsUint16(RD),
    ...encodeDnsUint16(1),
    ...encodeDnsUint16(0),
    ...encodeDnsUint16(0),
    ...encodeDnsUint16(additionals),
    ...encodeDnsName(query.name),
    ...encodeDnsUint16(DNS_TYPE_CODES[query.type]),
    ...encodeDnsUint16(DNS_CLASS_IN),

    // 1232 bytes is the EDNS payload size that dig and systemd-resolved send.
    ...(edns ? [0, ...encodeDnsUint16(TYPE_OPT), ...encodeDnsUint16(1232), 0, 0, 0, 0, 0, 0] : []),
  ]);
}
