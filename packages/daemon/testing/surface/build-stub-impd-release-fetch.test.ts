import { expect, mock, test } from 'bun:test';
import { buildStubImpdReleaseFetch } from './build-stub-impd-release-fetch';

test.each([['system/features'], ['system/info']])(
  'it takes the named feature flags out of %s and keeps the rest',
  async (procedure) => {
    const older = buildStubImpdReleaseFetch(
      () =>
        Promise.resolve(
          Response.json({
            json: { version: '0.40.1', features: { grantableTokens: true, sessionLog: true } },
            meta: [],
          }),
        ),
      { withoutFeatures: ['grantableTokens'] },
    );

    const response = await older.fetch(
      new Request(`http://impd.test/rpc/${procedure}`, { method: 'POST' }),
    );

    const body: unknown = await response.json();

    expect(body).toStrictEqual({
      json: { version: '0.40.1', features: { sessionLog: true } },
      meta: [],
    });
  },
);

test('it takes the whole features object out of system.info for a release before it', async () => {
  const older = buildStubImpdReleaseFetch(
    () =>
      Promise.resolve(
        Response.json({ json: { version: '0.40.1', features: { sessionLog: true } }, meta: [] }),
      ),
    { isWithoutFeatureList: true },
  );

  const response = await older.fetch(
    new Request('http://impd.test/rpc/system/info', { method: 'POST' }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: { version: '0.40.1' }, meta: [] });
});

test('it adds no features object to a system.info that had none', async () => {
  const older = buildStubImpdReleaseFetch(
    () => Promise.resolve(Response.json({ json: { version: '0.14.0' }, meta: [] })),
    { withoutFeatures: ['sessionLog'] },
  );

  const response = await older.fetch(
    new Request('http://impd.test/rpc/system/info', { method: 'POST' }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: { version: '0.14.0' }, meta: [] });
});

test('it sends a procedure the release lacked to a path no impd has', async () => {
  const inner = mock((request: Request) => Promise.resolve(new Response(request.url)));
  const older = buildStubImpdReleaseFetch(inner, { withoutProcedures: ['moves/facts'] });

  const response = await older.fetch(
    new Request('http://impd.test/base/rpc/moves/facts', { method: 'POST' }),
  );

  const text = await response.text();

  expect(text).toBe('http://impd.test/base/rpc/older-impd/absent');
});

test('it takes the named fields out of an object answer and keeps the rest', async () => {
  const older = buildStubImpdReleaseFetch(
    () =>
      Promise.resolve(
        Response.json({
          json: { name: 'dev-b', grantsNotCopied: [], grantsError: 'the copy failed' },
          meta: [[1, 'createdAt']],
        }),
      ),
    { withoutFields: { 'imps/fork': ['grantsNotCopied', 'grantsError'] } },
  );

  const response = await older.fetch(
    new Request('http://impd.test/rpc/imps/fork', { method: 'POST' }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: { name: 'dev-b' }, meta: [[1, 'createdAt']] });
});

test('it adds the named fields to each item of a list answer and keeps the rest', async () => {
  const newer = buildStubImpdReleaseFetch(
    () =>
      Promise.resolve(
        Response.json({ json: [{ name: 'web' }, { name: 'db' }], meta: [[1, 0, 'createdAt']] }),
      ),
    { withFields: { 'imps/list': { host: 'peer' } } },
  );

  const response = await newer.fetch(
    new Request('http://impd.test/rpc/imps/list', { method: 'POST' }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: [
      { name: 'web', host: 'peer' },
      { name: 'db', host: 'peer' },
    ],
    meta: [[1, 0, 'createdAt']],
  });
});

test('it adds the named fields to an object answer under a path prefix', async () => {
  const newer = buildStubImpdReleaseFetch(
    () => Promise.resolve(Response.json({ json: { name: 'web' }, meta: [] })),
    { withFields: { 'imps/get': { host: 'peer' } } },
  );

  const response = await newer.fetch(
    new Request('http://impd.test/base/rpc/imps/get', { method: 'POST' }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: { name: 'web', host: 'peer' }, meta: [] });
});

test('it passes the answer of another procedure as it came', async () => {
  const answer = Response.json({ json: { features: { sessionLog: true } } });

  const older = buildStubImpdReleaseFetch(() => Promise.resolve(answer), {
    withoutFeatures: ['sessionLog'],
    withoutProcedures: ['moves/facts'],
    withoutFields: { 'imps/fork': ['grantsNotCopied'] },
    withFields: { 'imps/get': { host: 'peer' } },
  });

  const response = await older.fetch(
    new Request('http://impd.test/rpc/imps/list', { method: 'POST' }),
  );

  expect(response).toBe(answer);
});

test('it passes a failed answer as it came', async () => {
  const answer = Response.json({ json: { code: 'UNAUTHORIZED' } }, { status: 401 });

  const older = buildStubImpdReleaseFetch(() => Promise.resolve(answer), {
    withoutFeatures: ['sessionLog'],
  });

  const response = await older.fetch(
    new Request('http://impd.test/rpc/system/info', { method: 'POST' }),
  );

  expect(response).toBe(answer);
});

test('it drops the named events of a stream and keeps the others and its end', async () => {
  const stream = [
    'event: message\ndata: {"json":{"type":"progress","phase":"pull"}}',
    'event: message\ndata: {"json":{"type":"image","image":{}}}',
    'event: done\ndata: {"json":null}',
    '',
  ].join('\n\n');

  const older = buildStubImpdReleaseFetch(
    () =>
      Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })),
    { withoutEvents: { 'images/addStream': ['image'] } },
  );

  const response = await older.fetch(
    new Request('http://impd.test/rpc/images/addStream', { method: 'POST' }),
  );

  const text = await response.text();

  expect(text).toBe(
    [
      'event: message\ndata: {"json":{"type":"progress","phase":"pull"}}',
      'event: done\ndata: {"json":null}',
      '',
    ].join('\n\n'),
  );
});

test('it records the procedure of each call it forwards', async () => {
  const older = buildStubImpdReleaseFetch(() =>
    Promise.resolve(Response.json({ json: { features: {} }, meta: [] })),
  );

  await older.fetch(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));
  await older.fetch(new Request('http://impd.test/rpc/system/info', { method: 'POST' }));

  expect(older.calls).toStrictEqual(['imps/list', 'system/info']);
});

test('it forwards a request outside the RPC routes as it came, unrecorded', async () => {
  const answer = new Response('exec');

  const older = buildStubImpdReleaseFetch(() => Promise.resolve(answer));

  const response = await older.fetch(new Request('http://impd.test/exec'));

  expect(response).toBe(answer);
  expect(older.calls).toBeEmpty();
});
