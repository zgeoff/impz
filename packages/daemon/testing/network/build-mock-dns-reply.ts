import { DNS_CLASS_IN, DNS_TYPE_CODES, encodeDnsName, encodeDnsUint16 } from './write-dns-wire';

const QR = 0x80_00;
const TC = 0x02_00;
const RD = 0x01_00;
const RA = 0x00_80;

export interface MockDnsRecord {
  readonly type: 'A' | 'AAAA' | 'CNAME';
  readonly name: string;
  readonly ttl: number;
  readonly data: string;
}

interface MockDnsReply {
  readonly answers: readonly MockDnsRecord[];
  readonly authorities: readonly MockDnsRecord[];
  readonly additionals: readonly MockDnsRecord[];
  readonly truncated: boolean;
  readonly id: number;
}

export function buildMockDnsReply(
  query: Uint8Array,
  reply: Readonly<Partial<MockDnsReply>> = {},
): Uint8Array {
  const answers = reply.answers ?? [];
  const authorities = reply.authorities ?? [];
  const additionals = reply.additionals ?? [];
  const id = reply.id ?? ((query[0] ?? 0) << 8) | (query[1] ?? 0);
  const flags = QR | RD | RA | (reply.truncated === true ? TC : 0);

  return Uint8Array.from([
    ...encodeDnsUint16(id),
    ...encodeDnsUint16(flags),
    ...encodeDnsUint16(1),
    ...encodeDnsUint16(answers.length),
    ...encodeDnsUint16(authorities.length),
    ...encodeDnsUint16(additionals.length),
    ...getQuestion(query),
    ...[...answers, ...authorities, ...additionals].flatMap((record) => encodeRecord(record)),
  ]);
}

function getQuestion(query: Uint8Array): number[] {
  let end = 12;

  while ((query[end] ?? 0) !== 0) {
    end += 1 + (query[end] ?? 0);
  }

  return [...query.subarray(12, end + 5)];
}

function encodeRecord(record: MockDnsRecord): number[] {
  const data = writeRecordData(record);

  return [
    ...encodeDnsName(record.name),
    ...encodeDnsUint16(DNS_TYPE_CODES[record.type]),
    ...encodeDnsUint16(DNS_CLASS_IN),
    ...encodeDnsUint16(Math.floor(record.ttl / 0x1_00_00)),
    ...encodeDnsUint16(record.ttl % 0x1_00_00),
    ...encodeDnsUint16(data.length),
    ...data,
  ];
}

function writeRecordData(record: MockDnsRecord): number[] {
  if (record.type === 'A') {
    return record.data.split('.').map(Number);
  }

  if (record.type === 'AAAA') {
    return writeIpv6(record.data);
  }

  return encodeDnsName(record.data);
}

function writeIpv6(address: string): number[] {
  const [head = '', tail = ''] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const fill = Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => '0');
  const groups = address.includes('::') ? [...headGroups, ...fill, ...tailGroups] : headGroups;

  return groups.flatMap((group) => encodeDnsUint16(Number.parseInt(group, 16)));
}
