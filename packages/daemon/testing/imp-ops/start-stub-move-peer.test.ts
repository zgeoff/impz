import { expect, onTestFinished, test } from 'bun:test';
import { startStubMovePeer } from './start-stub-move-peer';

test('it answers a path in its table with the status, body and headers of that path', async () => {
  const stub = startStubMovePeer({
    '/move/commit': {
      status: 410,
      body: { error: 'the commit window ended' },
      headers: { 'x-trace': 'stub' },
    },
  });

  const response = await fetch(`${stub.url}/move/commit`, { method: 'POST' });
  const body: unknown = await response.json();

  expect(response.status).toBe(410);
  expect(response.headers.get('x-trace')).toBe('stub');
  expect(body).toStrictEqual({ error: 'the commit window ended' });
});

test('it answers 200 for a path whose answer names no status', async () => {
  const stub = startStubMovePeer({ '/move/abort': { body: { isCommitted: false } } });

  const response = await fetch(`${stub.url}/move/abort`, { method: 'POST' });

  expect(response.status).toBe(200);
});

test('it answers a path left out of its table with 404 and the text an older target sends', async () => {
  const stub = startStubMovePeer({});

  const response = await fetch(`${stub.url}/move/offer`, { method: 'POST' });
  const body: unknown = await response.json();

  expect(response.status).toBe(404);
  expect(body).toStrictEqual({ error: 'not found' });
});

test('it records the method, path, ticket, content type and body of each request', async () => {
  const stub = startStubMovePeer({ '/move/offer': { body: {} } });

  await fetch(`${stub.url}/move/offer`, {
    method: 'POST',
    headers: { authorization: 'ImpMove ticket-id.secret', 'content-type': 'application/json' },
    body: '{"imageDigest":"sha256:abc"}',
  });

  expect(stub.received).toStrictEqual([
    {
      method: 'POST',
      path: '/move/offer',
      authorization: 'ImpMove ticket-id.secret',
      contentType: 'application/json',
      body: '{"imageDigest":"sha256:abc"}',
    },
  ]);
});

test('it closes its server when the test ends, with no stop called', () => {
  const stub = startStubMovePeer({});

  onTestFinished(async () => {
    await expect(fetch(`${stub.url}/move/commit`, { method: 'POST' })).toReject();
  });
});

test('it refuses connections once stopped', async () => {
  const stub = startStubMovePeer({});

  await stub.stop();

  expect(fetch(`${stub.url}/move/commit`, { method: 'POST' })).rejects.toThrow();
});
