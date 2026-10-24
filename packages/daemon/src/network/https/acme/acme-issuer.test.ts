import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { startStubAcmeServer } from '../../../../testing/network/start-stub-acme-server';
import { captureImpdLogs } from '../../../../testing/platform/capture-impd-logs';
import { createChalltestsrvProvider } from '../dns/challtestsrv-provider';
import { createAcmeIssuer } from './acme-issuer';
import { createCertStore } from './cert-store';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-acme-issuer-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { stack, directoryPath: directory };
}

test('it rejects an order whose authorization offers no dns-01 challenge', async () => {
  const ctx = await setupTest();

  const acmeServer = startStubAcmeServer(ctx.stack, {
    challengeTypes: ['http-01', 'tls-alpn-01'],
  });

  const issue = createAcmeIssuer({
    directoryUrl: acmeServer.directoryUrl,
    email: null,
    caPem: null,
    store: createCertStore(ctx.directoryPath),

    dns: createChalltestsrvProvider('http://127.0.0.1:9'),
  });

  const issued = issue('imp.test');

  expect(issued).rejects.toThrow(new Error('the CA offers no dns-01 challenge for imp.test'));
  expect(acmeServer.unexpected).toStrictEqual([]);
});

test('it logs a TXT record it could not remove after an order fails', async () => {
  const ctx = await setupTest();

  const acmeServer = startStubAcmeServer(ctx.stack, { challengeTypes: ['dns-01'] });

  server.use(
    http.post('http://challtestsrv.test/set-txt', () => new HttpResponse(null, { status: 200 }), {
      once: true,
    }),
    http.post('http://challtestsrv.test/set-txt', () => new HttpResponse(null, { status: 503 })),
    http.post('http://challtestsrv.test/clear-txt', () => new HttpResponse(null, { status: 503 })),
  );

  const issue = createAcmeIssuer({
    directoryUrl: acmeServer.directoryUrl,
    email: null,
    caPem: null,
    store: createCertStore(ctx.directoryPath),
    dns: createChalltestsrvProvider('http://challtestsrv.test'),
  });

  const logs = captureImpdLogs();

  await expect(issue('imp.test')).toReject();

  expect(logs).toStrictEqual([
    'WARNING impd.https could not remove the TXT record _acme-challenge.imp.test: challtestsrv /clear-txt: 503',
  ]);
});
