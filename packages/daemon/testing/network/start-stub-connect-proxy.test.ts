import { expect, onTestFinished, test } from 'bun:test';
import { createConnection } from 'node:net';
import { waitFor } from '@impz/test-utils/wait-for';
import { startStubConnectProxy } from './start-stub-connect-proxy';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const received: string[] = [];

  const target = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket, data) => {
        received.push(data.toString());
        socket.write(`echo ${data.toString()}`);
      },
    },
  });

  stack.defer(() => {
    target.stop(true);
  });

  return { stack, targetPort: target.port, received };
}

test('it answers a CONNECT with 200, records it, and pipes bytes both ways to its port', async () => {
  const ctx = setupTest();

  const proxy = await startStubConnectProxy(ctx.stack, { targetPort: ctx.targetPort });

  const replies: string[] = [];
  const client = createConnection({ host: '127.0.0.1', port: proxy.port });

  ctx.stack.defer(() => {
    client.destroy();
  });

  client.on('data', (chunk: Buffer) => {
    replies.push(chunk.toString());
  });

  client.write(
    'CONNECT realtime.example.com:443 HTTP/1.1\r\nHost: realtime.example.com:443\r\n\r\n',
  );

  await waitFor(() => {
    expect(replies).toHaveLength(1);
  });

  client.write('hello');

  await waitFor(() => {
    expect(replies).toHaveLength(2);
  });

  expect(proxy.connects).toStrictEqual(['CONNECT realtime.example.com:443 HTTP/1.1']);
  expect(replies).toStrictEqual(['HTTP/1.1 200 Connection Established\r\n\r\n', 'echo hello']);
  expect(ctx.received).toStrictEqual(['hello']);
});
