import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubBrokerTlsUpstream } from '../../../testing/network/start-stub-broker-tls-upstream';
import { sendWithCa } from './send-with-ca';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'send-with-ca-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { stack, directoryPath: directory };
}

test('it reaches an upstream that only the given CA vouches for', async () => {
  const ctx = await setupTest();

  const recordBody = mock<(body: string) => void>();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    directory: ctx.directoryPath,
    respond: async (request: Request) => {
      const body = await request.text();

      recordBody(body);

      return new Response('issued');
    },
  });

  const response = await sendWithCa(`${upstream.origin}/token`, {
    method: 'POST',
    body: 'grant_type=refresh_token',
    tls: { ca: [upstream.caPem] },
  });

  const text = await response.text();

  expect(text).toBe('issued');
  expect(recordBody).toHaveBeenCalledExactlyOnceWith('grant_type=refresh_token');
});

test('it refuses an upstream that no trusted CA vouches for when it is given no CA', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    directory: ctx.directoryPath,
    respond: () => new Response('reached'),
  });

  expect(sendWithCa(`${upstream.origin}/token`, { method: 'POST' })).rejects.toMatchObject({
    code: expect.toBeOneOf(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']),
  });
});
