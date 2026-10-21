import * as dnsPacket from 'dns-packet';
import type { Packet } from 'dns-packet';

// A busybox guest has nc and printf but no dig: the query goes out as a
// printf of octal escapes, and the reply comes back as od's hex.

export function buildTcpQueryOctal(name: string): string {
  const query = dnsPacket.encode({
    type: 'query',
    id: 26,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name, type: 'A' }],
    additionals: [
      {
        type: 'OPT',
        name: '.',
        udpPayloadSize: 1232,
        extendedRcode: 0,
        ednsVersion: 0,
        flags: 0,
        flag_do: false,
        options: [],
      },
    ],
  });

  const framed = Buffer.concat([Buffer.from([0, query.byteLength]), query]);

  return [...framed].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
}

export interface TcpReply {
  readonly reply: Packet;

  readonly lastOption: readonly [number, number];
}

export function parseTcpReplyHex(hex: string): TcpReply {
  const bytes = Buffer.from(hex.replaceAll(/\s/gv, ''), 'hex').subarray(2);
  const tail = bytes.subarray(-6);

  return {
    reply: dnsPacket.decode(bytes),
    lastOption: [tail.readUInt16BE(0), tail.readUInt16BE(4)],
  };
}
