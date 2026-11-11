import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect as connectSocket } from 'node:net';
import { connect as connectTls } from 'node:tls';

interface RawRequestOptions {
  readonly proxyPort: number;
  readonly caFile: string;

  // the imp's address, which names it to the broker
  readonly address: string;
  readonly host: string;

  // sent as written, so a test can send what a Request object cannot hold:
  // a repeated header line or an obs-folded one. It ends with Connection:
  // close, which makes the server hang up after its reply.
  readonly raw: string;
}

// Opens a CONNECT through the broker, runs TLS to the terminator, writes the
// raw request, and answers everything the terminator sends back.
export async function sendStubBrokerRawRequest(
  options: Readonly<RawRequestOptions>,
): Promise<string> {
  const plain = connectSocket({
    host: '127.0.0.1',
    port: options.proxyPort,
    localAddress: options.address,
  });

  try {
    await once(plain, 'connect');

    plain.write(`CONNECT ${options.host}:443 HTTP/1.1\r\nHost: ${options.host}:443\r\n\r\n`);

    const answers: unknown[] = await once(plain, 'data');

    const answer = answers.at(0);

    if (!String(answer).startsWith('HTTP/1.1 200')) {
      throw new Error(`the broker refused the CONNECT: ${String(answer)}`);
    }

    const secure = connectTls({
      socket: plain,
      servername: options.host,
      ca: readFileSync(options.caFile),
    });

    await once(secure, 'secureConnect');

    const chunks: Buffer[] = [];

    secure.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    secure.write(options.raw);

    await once(secure, 'close');

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    plain.destroy();
  }
}
