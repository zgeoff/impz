import { expect, mock, onTestFinished, test } from 'bun:test';
import { claimFreePorts } from '@impz/test-utils/claim-free-ports';
import { buildMockMoveTicketRow } from '../../../testing/imp-ops/build-mock-move-ticket-row';
import { startStubMovePeer } from '../../../testing/imp-ops/start-stub-move-peer';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import type { MovePeerCalls } from '../../imp-ops/moves/move-receiver';
import { MoveRequestError } from '../../imp-ops/moves/move-request-error';
import { buildPeerRanges } from '../../imp-ops/moves/peer-address';
import { requireMoveTicket } from '../../imp-ops/moves/require-move-ticket';
import { writeMoveTicket } from '../../platform/db/move-tickets';
import { hashSecret } from '../../platform/secrets/hash-secret';
import { createMovePeerHandler } from './create-move-peer-handler';
import { makeConnectMovePeer } from './make-connect-move-peer';

// The client and the handler of one build, over real HTTP on a claimed port.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const database = await createTestDatabase();

  const calls = {
    ranges: buildPeerRanges(null),
    requireTicket: (request: Request) => requireMoveTicket(database.db, request),
    offer: mock<MovePeerCalls['offer']>(),
    receive: mock<MovePeerCalls['receive']>(),
    commit: mock<MovePeerCalls['commit']>(),
    abort: mock<MovePeerCalls['abort']>(),
  };

  const handler = createMovePeerHandler({
    calls,
    audit: { record: () => {} },
    now: () => 1_800_000_000_000,
  });

  const port = claimFreePorts(1, { onRelease: stack.defer.bind(stack) }).take();
  const handleRequest = (request: Request) => handler.respond(request, '100.64.0.1');
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handleRequest });

  stack.defer(() => server.stop(true));

  return { db: database.db, calls, url: `http://127.0.0.1:${String(port)}` };
}

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

test('it sends an offer the handler of the same build takes, and reads its reply', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(
    ctx.db,
    buildMockMoveTicketRow({ id: 'ticket-1', secret_sha256: hashSecret('s3cret').toString('hex') }),
  );

  ctx.calls.offer.mockResolvedValue({
    needsImage: true,
    needsSystemDrive: false,
    storage: 'zfs',
    keepsMaxMemory: true,
    keepsLeases: true,
    keepsPublicEgress: true,
    keepsBackupOff: true,
  });

  const peer = makeConnectMovePeer({})({ peer: ctx.url, ticket: 'ticket-1.s3cret' });

  const reply = await peer.offer(
    { imageDigest: 'sha256:abc', receivedImageDigest: 'sha256:def' },
    new AbortController().signal,
  );

  expect(ctx.calls.offer).toHaveBeenCalledExactlyOnceWith({
    imageDigest: 'sha256:abc',
    receivedImageDigest: 'sha256:def',
  });

  expect(reply).toStrictEqual({
    needsImage: true,
    needsSystemDrive: false,
    storage: 'zfs',
    keepsMaxMemory: true,
    keepsLeases: true,
    keepsPublicEgress: true,
    keepsBackupOff: true,
  });
});

test('it sends a commit the handler of the same build takes, for the ticket it names', async () => {
  const ctx = await setupTest();

  const row = buildMockMoveTicketRow({
    id: 'ticket-1',
    secret_sha256: hashSecret('s3cret').toString('hex'),
  });

  await writeMoveTicket(ctx.db, row);

  ctx.calls.commit.mockResolvedValue({ isCommitted: true });

  const peer = makeConnectMovePeer({})({ peer: ctx.url, ticket: 'ticket-1.s3cret' });

  const reply = await peer.commit();

  expect(reply).toStrictEqual({ isCommitted: true });

  expect(ctx.calls.commit).toHaveBeenCalledExactlyOnceWith({
    row,
    ticket: { id: 'ticket-1', secret: 's3cret' },
  });
});

test.each([
  [true, 'committed'],
  [false, 'aborted'],
] as const)(
  'it reads the abort answer isCommitted %p of the handler of the same build as %s',
  async (isCommitted, outcome) => {
    const ctx = await setupTest();

    await writeMoveTicket(
      ctx.db,
      buildMockMoveTicketRow({
        id: 'ticket-1',
        secret_sha256: hashSecret('s3cret').toString('hex'),
      }),
    );

    ctx.calls.abort.mockResolvedValue({ isCommitted });

    const peer = makeConnectMovePeer({})({ peer: ctx.url, ticket: 'ticket-1.s3cret' });

    const answered = await peer.abort();

    expect(answered).toBe(outcome);
    expect(ctx.calls.abort).toHaveBeenCalledOnce();
  },
);

test('it reads the refusal of a ticket the handler of the same build does not hold as an unknown ticket', async () => {
  const ctx = await setupTest();

  const peer = makeConnectMovePeer({})({ peer: ctx.url, ticket: 'ticket-1.s3cret' });

  const answered = await peer.abort();

  expect(answered).toBe('unknown-ticket');
  expect(ctx.calls.abort).not.toHaveBeenCalled();
});

test('it names the error the handler of the same build answers a commit with', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(
    ctx.db,
    buildMockMoveTicketRow({ id: 'ticket-1', secret_sha256: hashSecret('s3cret').toString('hex') }),
  );

  ctx.calls.commit.mockRejectedValue(
    new MoveRequestError('CONFLICT', 'nothing to commit: the received copy is gone'),
  );

  const peer = makeConnectMovePeer({})({ peer: ctx.url, ticket: 'ticket-1.s3cret' });

  expect(peer.commit()).rejects.toThrowWithMessage(
    Error,
    'commit: the target answered 409 nothing to commit: the received copy is gone',
  );
});
