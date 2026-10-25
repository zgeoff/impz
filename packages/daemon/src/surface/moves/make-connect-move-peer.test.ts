import { expect, test } from 'bun:test';
import { startStubMovePeer } from '../../../testing/imp-ops/start-stub-move-peer';
import { makeConnectMovePeer } from './make-connect-move-peer';

test('it posts the offer as JSON to the offer route with the ticket', async () => {
  const stub = startStubMovePeer({
    '/move/offer': {
      body: {
        needsImage: true,
        needsSystemDrive: false,
        storage: 'xfs',
        keepsMaxMemory: true,
        keepsLeases: true,
        keepsPublicEgress: true,
        keepsBackupOff: true,
      },
    },
  });

  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  await peer.offer({ imageDigest: 'sha256:abc' }, new AbortController().signal);

  expect(stub.received).toStrictEqual([
    {
      method: 'POST',
      path: '/move/offer',
      authorization: 'ImpMove ticket-id.ticket-secret',
      contentType: 'application/json',
      body: '{"imageDigest":"sha256:abc"}',
    },
  ]);
});

test('it reads the offer reply of a target on the contract', async () => {
  const stub = startStubMovePeer({
    '/move/offer': {
      body: {
        needsImage: true,
        needsSystemDrive: true,
        storage: 'zfs',
        keepsMaxMemory: true,
        keepsLeases: true,
        keepsPublicEgress: true,
        keepsBackupOff: true,
      },
    },
  });

  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  const reply = await peer.offer({ imageDigest: 'sha256:abc' }, new AbortController().signal);

  expect(reply).toStrictEqual({
    needsImage: true,
    needsSystemDrive: true,
    storage: 'zfs',
    keepsMaxMemory: true,
    keepsLeases: true,
    keepsPublicEgress: true,
    keepsBackupOff: true,
  });
});

test('it reads each field an older target leaves out of its offer reply as false', async () => {
  const stub = startStubMovePeer({
    '/move/offer': { body: { needsImage: false, storage: 'zfs' } },
  });

  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  const reply = await peer.offer({ imageDigest: 'sha256:abc' }, new AbortController().signal);

  expect(reply).toStrictEqual({
    needsImage: false,
    needsSystemDrive: false,
    storage: 'zfs',
    keepsMaxMemory: false,
    keepsLeases: false,
    keepsPublicEgress: false,
    keepsBackupOff: false,
  });
});

test('it names the status and the text of an error body from an older target', () => {
  const stub = startStubMovePeer({
    '/move/commit': {
      status: 410,
      body: { error: 'the commit window ended; reissue the ticket' },
    },
  });

  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  expect(peer.commit()).rejects.toThrowWithMessage(
    Error,
    'commit: the target answered 410 the commit window ended; reissue the ticket',
  );
});

test('it names the status and the message of an error from a target on the contract', () => {
  const stub = startStubMovePeer({
    '/move/commit': {
      status: 409,
      body: {
        defined: false,
        code: 'CONFLICT',
        status: 409,
        message: 'nothing to commit: the received copy is gone',
        error: 'nothing to commit: the received copy is gone',
      },
    },
  });

  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  expect(peer.commit()).rejects.toThrowWithMessage(
    Error,
    'commit: the target answered 409 nothing to commit: the received copy is gone',
  );
});

test('it names the status of an error with no body text', () => {
  const stub = startStubMovePeer({ '/move/commit': { status: 502, body: {} } });
  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  expect(peer.commit()).rejects.toThrowWithMessage(
    Error,
    'commit: the target answered 502 with no error text',
  );
});

test('it names the 404 of an older target that lacks the route', () => {
  const stub = startStubMovePeer({});
  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  expect(peer.commit()).rejects.toThrowWithMessage(
    Error,
    'commit: the target answered 404 not found',
  );
});

test('it follows no redirect, so the ticket goes to no other host', async () => {
  const other = startStubMovePeer({ '/move/commit': { body: { isCommitted: true } } });

  const stub = startStubMovePeer({
    '/move/commit': { status: 307, body: {}, headers: { location: `${other.url}/move/commit` } },
  });

  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  const failure = await peer.commit().then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(other.received).toStrictEqual([]);
});

test.each([
  ['a target on the contract', 200, { isCommitted: true }, 'committed'],
  ['an older target', 409, { isCommitted: true }, 'committed'],
  ['a target that took it', 200, { isCommitted: false }, 'aborted'],
  ['an older target with no such ticket', 401, { error: 'unknown move ticket' }, 'unknown-ticket'],
  [
    'a target on the contract with no such ticket',
    401,
    {
      defined: false,
      code: 'UNAUTHORIZED',
      status: 401,
      message: 'unknown move ticket',
      error: 'unknown move ticket',
    },
    'unknown-ticket',
  ],
] as const)('it reads the abort answer of %s', async (_label, status, body, outcome) => {
  const stub = startStubMovePeer({ '/move/abort': { status, body } });
  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  const answered = await peer.abort();

  expect(answered).toBe(outcome);
});

test('it refuses an abort the target fails with another status', () => {
  const stub = startStubMovePeer({ '/move/abort': { status: 500, body: { error: 'disk full' } } });
  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  expect(peer.abort()).rejects.toThrowWithMessage(
    Error,
    'abort: the target answered 500 disk full',
  );
});

test('it passes on a transport failure to a target that is gone', async () => {
  const stub = startStubMovePeer({});

  await stub.stop();

  const peer = makeConnectMovePeer({})({ peer: stub.url, ticket: 'ticket-id.ticket-secret' });

  expect(peer.commit()).rejects.toThrow();
});
