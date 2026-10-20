import { expect, mock, onTestFinished, test } from 'bun:test';
import { claimFreePorts, startTestImpd } from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { HttpResponse, http } from 'msw';
import { createRpcClient } from '../create-rpc-client';
import { makeStubImpdWithoutFeature } from '../test-utils/make-stub-impd-without-feature';
import { checkExecFeatures } from './check-exec-features';

// impd booted in process on stub VMs, served at http://impd.test/ through
// the run's MSW server
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const harness = await startTestImpd(stack, { rootToken });

  const impd = harness.impd;

  server.use(http.all('http://impd.test/*', (info) => impd.api.app.handle(info.request)));

  return { impd, url: 'http://impd.test', rootToken };
}

test('it passes an impd that checks exec requirements', async () => {
  const ctx = await setupTest();

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toBeNull();
});

test('it sends the bearer token with the check', async () => {
  const ctx = await setupTest();

  const received = mock<(authorization: string | null) => void>();

  server.use(
    http.post('http://impd.test/rpc/system/features', (info) => {
      received(info.request.headers.get('authorization'));

      return ctx.impd.api.app.handle(info.request);
    }),
  );

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(received).toHaveBeenCalledExactlyOnceWith(`Bearer ${ctx.rootToken}`);
});

test('it reads the features once for several needs', async () => {
  const ctx = await setupTest();

  const received = mock<() => void>();

  server.use(
    http.post('http://impd.test/rpc/system/features', (info) => {
      received();

      return ctx.impd.api.app.handle(info.request);
    }),
  );

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  await checkExecFeatures(rpc, {
    execRequire: 'run it unchecked',
    execDropSysAdmin: 'run it with CAP_SYS_ADMIN',
  });

  expect(received).toHaveBeenCalledOnce();
});

test('it reports an impd that rejects the token as unauthorized', async () => {
  const ctx = await setupTest();

  const rpc = createRpcClient({ url: ctx.url, token: 'wrong' });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toStrictEqual({ kind: 'unauthorized' });
});

test('it refuses an impd from before exec requirements as PRECONDITION_FAILED', async () => {
  const ctx = await setupTest();

  const older = makeStubImpdWithoutFeature(
    (request) => ctx.impd.api.app.handle(request),
    'execRequire',
  );

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  const refusal = await checkExecFeatures(rpc, {
    execRequire: 'run the command without checking its requirements',
  });

  expect(refusal).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message:
      'nothing was started: this impd is older than 0.30.0 and would run the command without checking its requirements',
    data: {
      reason: 'impd_outdated',
      detail:
        'this impd is older than 0.30.0 and would run the command without checking its requirements',
    },
  });
});

test('it refuses an impd that cannot drop CAP_SYS_ADMIN as PRECONDITION_FAILED', async () => {
  const ctx = await setupTest();

  const older = makeStubImpdWithoutFeature(
    (request) => ctx.impd.api.app.handle(request),
    'execDropSysAdmin',
  );

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const rpc = createRpcClient({ url: ctx.url, token: ctx.rootToken });

  const refusal = await checkExecFeatures(rpc, {
    execDropSysAdmin: 'run the command with CAP_SYS_ADMIN',
  });

  expect(refusal).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message:
      'nothing was started: this impd cannot drop CAP_SYS_ADMIN from a command and would run the command with CAP_SYS_ADMIN',
    data: {
      reason: 'impd_outdated',
      detail:
        'this impd cannot drop CAP_SYS_ADMIN from a command and would run the command with CAP_SYS_ADMIN',
    },
  });
});

test('it reports an impd it cannot reach as unreachable', async () => {
  // nothing listens on a free port
  const rpc = createRpcClient({
    url: `http://127.0.0.1:${String(claimFreePorts(1).take())}`,
    token: 'root-token',
  });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toStrictEqual({
    kind: 'unreachable',
    detail: expect.toStartWith('feature check: '),
  });
});

test('it refuses a start when impd fails the check', async () => {
  // a proxy in front of impd answers while impd is down
  server.use(
    http.post(
      'http://impd.test/rpc/system/features',
      () => new HttpResponse('down', { status: 503 }),
    ),
  );

  const rpc = createRpcClient({ url: 'http://impd.test', token: 'root-token' });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toStrictEqual({
    kind: 'failed',
    code: null,
    message: 'impd answered the feature check with 503; nothing was started',
  });
});

test('it refuses a start when impd answers the check with no feature flags', async () => {
  // a features answer without its flags, which no impd sends
  server.use(
    http.post('http://impd.test/rpc/system/features', () =>
      HttpResponse.json({ json: { version: '0.40.1' } }),
    ),
  );

  const rpc = createRpcClient({ url: 'http://impd.test', token: 'root-token' });

  const refusal = await checkExecFeatures(rpc, { execRequire: 'run it unchecked' });

  expect(refusal).toMatchObject({ kind: 'failed', code: 'PRECONDITION_FAILED' });
});
