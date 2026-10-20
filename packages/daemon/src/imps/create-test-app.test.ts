import { expect, onTestFinished, test } from 'bun:test';
import { StubVmError } from '../test-utils/build-stub-vmm';
import { createTestApp } from './create-test-app';
import { createImpTest } from './test-imps';

test('#createTestApp serves the API over the harness', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const app = createTestApp(harness, harness);

  const imps = await app.client.imps.list({});

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('#createTestApp records an unexpected RPC failure in the harness', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');

  const app = createTestApp(harness, harness);

  harness.fake.queue('boot', 'fail');

  expect(app.client.imps.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  expect(harness.rpcFailures).toStrictEqual([expect.any(StubVmError)]);
});

test('#createTestApp logs an unexpected RPC failure to the harness log', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');

  const app = createTestApp(harness, harness);

  harness.fake.queue('boot', 'fail');

  expect(app.client.imps.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  expect(harness.logs).toSatisfyAny(
    (line: string) =>
      line.startsWith('impd: rpc failed: ') && line.includes('StubVmError: boot failed: no agent'),
  );
});

test('#createTestApp records no failure the API returns as an expected error', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  const app = createTestApp(harness, harness);

  expect(app.client.imps.get({ name: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(harness.rpcFailures).toBeEmpty();
});
