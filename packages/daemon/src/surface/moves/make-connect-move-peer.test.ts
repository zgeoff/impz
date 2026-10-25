import { expect, mock, test } from 'bun:test';
import { makeConnectMovePeer } from './make-connect-move-peer';

test('it posts the offer as JSON to the offer route with the ticket', async () => {
  const send = mock<(request: Request) => Promise<Response>>(() =>
    Promise.resolve(
      Response.json({
        needsImage: true,
        needsSystemDrive: false,
        storage: 'xfs',
        keepsMaxMemory: true,
        keepsLeases: true,
        keepsPublicEgress: true,
        keepsBackupOff: true,
      }),
    ),
  );

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  await peer.offer({ imageDigest: 'sha256:abc' }, new AbortController().signal);

  const request = send.mock.calls[0]?.[0];

  const body: unknown = await request?.json();

  expect(request?.url).toBe('http://100.64.0.2:7070/move/offer');
  expect(request?.method).toBe('POST');
  expect(request?.redirect).toBe('manual');
  expect(request?.headers.get('authorization')).toBe('ImpMove ticket-id.ticket-secret');
  expect(request?.headers.get('content-type')).toBe('application/json');
  expect(body).toStrictEqual({ imageDigest: 'sha256:abc' });
});

test('it reads each field an older target leaves out of its offer reply as false', async () => {
  const send = mock(() => Promise.resolve(Response.json({ needsImage: false, storage: 'zfs' })));

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

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

test('it names the status and the text of an error from an older target', () => {
  const send = mock(() =>
    Promise.resolve(
      Response.json({ error: 'the commit window ended; reissue the ticket' }, { status: 410 }),
    ),
  );

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  expect(peer.commit()).rejects.toThrowWithMessage(
    Error,
    'commit: the target answered 410 the commit window ended; reissue the ticket',
  );
});

test('it names the status and the message of an error from a target on the contract', () => {
  const send = mock(() =>
    Promise.resolve(
      Response.json(
        {
          defined: false,
          code: 'CONFLICT',
          status: 409,
          message: 'nothing to commit: the received copy is gone',
          error: 'nothing to commit: the received copy is gone',
        },
        { status: 409 },
      ),
    ),
  );

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  expect(peer.commit()).rejects.toThrowWithMessage(
    Error,
    'commit: the target answered 409 nothing to commit: the received copy is gone',
  );
});

test('it reads the abort of a committed move as committed', async () => {
  const send = mock(() => Promise.resolve(Response.json({ isCommitted: true })));

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  const outcome = await peer.abort();

  expect(outcome).toBe('committed');
});

test('it reads the 409 an older target sends for the abort of a committed move as committed', async () => {
  const send = mock(() => Promise.resolve(Response.json({ isCommitted: true }, { status: 409 })));

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  const outcome = await peer.abort();

  expect(outcome).toBe('committed');
});

test('it reads an abort the target took as aborted', async () => {
  const send = mock(() => Promise.resolve(Response.json({ isCommitted: false })));

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  const outcome = await peer.abort();

  expect(outcome).toBe('aborted');
});

test('it reads an abort the target answers with 401 as an unknown ticket', async () => {
  const send = mock(() =>
    Promise.resolve(Response.json({ error: 'unknown move ticket' }, { status: 401 })),
  );

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  const outcome = await peer.abort();

  expect(outcome).toBe('unknown-ticket');
});

test('it refuses an abort the target fails with another status', () => {
  const send = mock(() => Promise.resolve(Response.json({ error: 'disk full' }, { status: 500 })));

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  expect(peer.abort()).rejects.toThrowWithMessage(
    Error,
    'abort: the target answered 500 disk full',
  );
});

test('it passes on a transport failure as it is', () => {
  const send = mock(() => Promise.reject(new Error('connection refused')));

  const peer = makeConnectMovePeer({ fetch: send })({
    peer: 'http://100.64.0.2:7070',
    ticket: 'ticket-id.ticket-secret',
  });

  expect(peer.commit()).rejects.toThrowWithMessage(Error, 'connection refused');
});
