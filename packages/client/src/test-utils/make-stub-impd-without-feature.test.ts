import { expect, test } from 'bun:test';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { makeStubImpdWithoutFeature } from './make-stub-impd-without-feature';

function setupTest() {
  return { serializer: new StandardRPCSerializer(new StandardRPCJsonSerializer()) };
}

test.each([['/rpc/system/features'], ['/rpc/system/info']])(
  'it drops the feature from the answer to %s and keeps the rest',
  async (path) => {
    const ctx = setupTest();

    const older = makeStubImpdWithoutFeature(
      () =>
        Promise.resolve(
          Response.json(
            ctx.serializer.serialize({
              version: '0.40.2',
              features: { execRequire: true, leases: true },
            }),
          ),
        ),
      'execRequire',
    );

    const response = await older(new Request(`http://impd.test${path}`, { method: 'POST' }));
    const body: unknown = await response.json();

    expect(ctx.serializer.deserialize(body)).toStrictEqual({
      version: '0.40.2',
      features: { leases: true },
    });
  },
);

test('it passes another call through unchanged', async () => {
  const ctx = setupTest();
  const answer = Response.json(ctx.serializer.serialize({ features: { execRequire: true } }));
  const older = makeStubImpdWithoutFeature(() => Promise.resolve(answer), 'execRequire');

  const response = await older(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));

  expect(response).toBe(answer);
});

test('it passes a refused feature read through unchanged', async () => {
  const answer = new Response(null, { status: 401 });

  const older = makeStubImpdWithoutFeature(() => Promise.resolve(answer), 'execDropSysAdmin');

  const response = await older(
    new Request('http://impd.test/rpc/system/features', { method: 'POST' }),
  );

  expect(response).toBe(answer);
});
