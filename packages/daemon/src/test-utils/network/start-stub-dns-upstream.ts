import { onTestFinished } from 'bun:test';
import { buildMockDnsReply } from './build-mock-dns-reply';
import type { MockDnsRecord } from './build-mock-dns-reply';

export type StubDnsUdpMode = 'answer' | 'truncate' | 'drop' | 'wrong-id';

export type StubDnsTcpMode = 'answer' | 'drop' | 'hang-up' | 'wrong-id';

interface StubDnsUpstreamOptions {
  // A UDP bind to port 0 can pick a number a TCP socket already holds, so the
  // caller passes a port that is free for both.
  readonly port: number;

  readonly hostname?: string;
  readonly answers?: readonly MockDnsRecord[];
  readonly udp?: StubDnsUdpMode;
  readonly tcp?: StubDnsTcpMode;
}

interface StubDnsQueryRecord {
  readonly transport: 'udp' | 'tcp';
  readonly id: number;
}

export async function startStubDnsUpstream(options: Readonly<StubDnsUpstreamOptions>) {
  const queries: StubDnsQueryRecord[] = [];
  const answers = options.answers ?? [];
  const udpMode = options.udp ?? 'answer';
  const tcpMode = options.tcp ?? 'answer';

  const buildReply = (query: Uint8Array, mode: StubDnsUdpMode | StubDnsTcpMode): Uint8Array =>
    buildMockDnsReply(query, {
      answers: mode === 'truncate' ? [] : answers,
      truncated: mode === 'truncate',
      id: mode === 'wrong-id' ? (getId(query) + 1) % 0x1_00_00 : getId(query),
    });

  const udp = await Bun.udpSocket({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port,
    socket: {
      data: (socket, data, port, address) => {
        const query = new Uint8Array(data);

        if (udpMode !== 'drop') {
          socket.send(buildReply(query, udpMode), port, address);
        }

        queries.push({ transport: 'udp', id: getId(query) });
      },
    },
  });

  onTestFinished(() => {
    udp.close();
  });

  const tcp = Bun.listen<{ buffered: Buffer }>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port,
    socket: {
      open: (socket) => {
        socket.data = { buffered: Buffer.alloc(0) };
      },
      data: (socket, chunk) => {
        socket.data.buffered = Buffer.concat([socket.data.buffered, chunk]);

        // One TCP chunk can hold several length-prefixed DNS messages.
        for (;;) {
          const buffered = socket.data.buffered;
          const length = buffered.byteLength >= 2 ? buffered.readUInt16BE(0) : -1;

          if (length < 0 || buffered.byteLength < 2 + length) {
            return;
          }

          const query = new Uint8Array(buffered.subarray(2, 2 + length));

          socket.data.buffered = buffered.subarray(2 + length);

          if (tcpMode === 'hang-up') {
            socket.end();
          } else if (tcpMode !== 'drop') {
            const reply = buildReply(query, tcpMode);
            const framed = Buffer.alloc(2 + reply.byteLength);

            framed.writeUInt16BE(reply.byteLength, 0);
            framed.set(reply, 2);
            socket.write(framed);
          }

          queries.push({ transport: 'tcp', id: getId(query) });
        }
      },
    },
  });

  onTestFinished(() => {
    tcp.stop(true);
  });

  return { port: udp.port, queries: queries as readonly StubDnsQueryRecord[] };
}

function getId(query: Uint8Array): number {
  return ((query[0] ?? 0) << 8) | (query[1] ?? 0);
}
