import { expect, onTestFinished, test } from 'bun:test';
import { claimFreePorts, startTestImpd } from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { createRpcClient } from '../create-rpc-client';
import { checkImpdAccess } from './check-impd-access';

// impd booted in process on stub VMs, served at http://impd.test/ through
// the run's MSW server
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const harness = await startTestImpd(stack, { rootToken });

  server.use(http.all('http://impd.test/*', (info) => harness.impd.api.app.handle(info.request)));

  return { url: 'http://impd.test', rootToken };
}

test('it reports an impd that takes the token as reachable', async () => {
  const ctx = await setupTest();
  const access = await checkImpdAccess(createRpcClient({ url: ctx.url, token: ctx.rootToken }));

  expect(access).toBe('reachable');
});

test('it reports an impd that rejects the token as unauthorized', async () => {
  const ctx = await setupTest();
  const access = await checkImpdAccess(createRpcClient({ url: ctx.url, token: 'wrong' }));

  expect(access).toBe('unauthorized');
});

test('it reports an older impd that has no system.features as reachable', async () => {
  // oRPC's router answers a procedure it does not know with NOT_FOUND
  server.use(
    http.post('http://impd.test/rpc/system/features', () =>
      HttpResponse.json(
        { json: { defined: false, code: 'NOT_FOUND', status: 404, message: 'Not found' } },
        { status: 404 },
      ),
    ),
  );

  const access = await checkImpdAccess(
    createRpcClient({ url: 'http://impd.test', token: 'root-token' }),
  );

  expect(access).toBe('reachable');
});

test('it reports an impd it cannot reach as unreachable', async () => {
  // nothing listens on a free port
  const port = claimFreePorts(1).take();

  const access = await checkImpdAccess(
    createRpcClient({ url: `http://127.0.0.1:${String(port)}`, token: 'root-token' }),
  );

  expect(access).toBe('unreachable');
});
