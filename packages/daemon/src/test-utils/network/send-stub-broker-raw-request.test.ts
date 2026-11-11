import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import invariant from 'tiny-invariant';
import { loadOrCreateBrokerCa } from '../../network/broker/tls/broker-ca';
import { sendStubBrokerRawRequest } from './send-stub-broker-raw-request';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'raw-request-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const ca = await loadOrCreateBrokerCa(join(directory, 'ca'));
  const leaf = await ca.issueLeaf('svc.imp.internal');

  const caFile = join(directory, 'ca.pem');

  await writeFile(caFile, ca.certPem);

  const written: string[] = [];

  const proxy = createServer((socket: Socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      const secure = new TLSSocket(socket, {
        isServer: true,
        cert: leaf.certPem,
        key: leaf.keyPem,
      });

      secure.on('data', (chunk: Buffer) => {
        written.push(chunk.toString('utf8'));
        secure.end('HTTP/1.1 204 No Content\r\n\r\n');
      });
    });
  });

  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve);
  });

  onTestFinished(() => {
    proxy.close();
  });

  const address = proxy.address();

  invariant(typeof address === 'object' && address !== null);

  return { caFile, written, proxyPort: address.port };
}

test('it writes the raw request through the tunnel as written and answers the reply', async () => {
  const ctx = await setupTest();

  const reply = await sendStubBrokerRawRequest({
    proxyPort: ctx.proxyPort,
    caFile: ctx.caFile,
    address: '127.0.0.1',
    host: 'svc.imp.internal',
    raw: 'GET / HTTP/1.1\r\nHost: svc.imp.internal\r\nImp-Identity: a\r\n b\r\n\r\n',
  });

  expect(reply).toBe('HTTP/1.1 204 No Content\r\n\r\n');

  expect(ctx.written.join('')).toBe(
    'GET / HTTP/1.1\r\nHost: svc.imp.internal\r\nImp-Identity: a\r\n b\r\n\r\n',
  );
});
