import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateBrokerCa } from '../../src/broker/broker-ca';
import { startStubBrokerTlsUpstream } from './start-stub-broker-tls-upstream';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'stub-tls-upstream-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { stack, directoryPath: directory };
}

test('it answers a client that trusts its CA through its handler', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    directory: ctx.directoryPath,
    fetch: (request) => new Response(`saw ${new URL(request.url).pathname}`),
  });

  const response = await fetch(`${upstream.origin}/x`, { tls: { ca: [upstream.caPem] } });
  const text = await response.text();

  expect(text).toBe('saw /x');
});

test('it refuses a client that trusts only another CA', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    directory: ctx.directoryPath,
    fetch: () => new Response('reached'),
  });

  const other = await loadOrCreateBrokerCa(join(ctx.directoryPath, 'other-ca'));

  expect(fetch(`${upstream.origin}/x`, { tls: { ca: [other.certPem] } })).rejects.toMatchObject({
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
});

test('it issues its certificate for the host it is given', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    directory: ctx.directoryPath,
    host: 'api.github.com',
    fetch: () => new Response('reached'),
  });

  expect(fetch(`${upstream.origin}/x`, { tls: { ca: [upstream.caPem] } })).rejects.toMatchObject({
    code: 'ERR_TLS_CERT_ALTNAME_INVALID',
  });
});

test('it answers on the port it gives', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerTlsUpstream(ctx.stack, {
    directory: ctx.directoryPath,
    fetch: () => new Response('reached'),
  });

  const response = await fetch(`https://localhost:${String(upstream.port)}/x`, {
    tls: { ca: [upstream.caPem] },
  });

  expect(response.status).toBe(200);
});
