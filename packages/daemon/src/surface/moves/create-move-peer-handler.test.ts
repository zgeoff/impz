import { expect, mock, test } from 'bun:test';
import { buildMockMoveTicketRow } from '../../../testing/imp-ops/build-mock-move-ticket-row';
import { MoveRequestError } from '../../imp-ops/moves/move-request-error';
import { createMovePeerHandler } from './create-move-peer-handler';

test('it answers the plain JSON offer an older source posts with the offer reply', async () => {
  const offer = mock(() =>
    Promise.resolve({
      needsImage: false,
      needsSystemDrive: false,
      storage: 'xfs' as const,
      keepsMaxMemory: true,
      keepsLeases: true,
      keepsPublicEgress: true,
      keepsBackupOff: true,
    }),
  );

  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => true,
      requireTicket: () =>
        Promise.resolve({
          row: buildMockMoveTicketRow({ name: 'dev' }),
          ticket: { id: 'ticket-id', secret: 'ticket-secret' },
        }),
      offer,
      receive: mock(),
      commit: mock(),
      abort: mock(),
    },
    audit: { record: () => {} },
    now: () => 1_800_000_000_000,
  });

  const response = await handler.respond(
    new Request('http://100.64.0.2:7070/move/offer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'ImpMove ticket-id.secret' },
      body: JSON.stringify({ imageDigest: 'sha256:abc' }),
    }),
    '100.64.0.1',
  );

  expect(response.status).toBe(200);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    needsImage: false,
    needsSystemDrive: false,
    storage: 'xfs',
    keepsMaxMemory: true,
    keepsLeases: true,
    keepsPublicEgress: true,
    keepsBackupOff: true,
  });

  expect(offer).toHaveBeenCalledExactlyOnceWith({
    imageDigest: 'sha256:abc',
    receivedImageDigest: null,
  });
});

test('it refuses a call from off the tailnet with the text an older source reads', async () => {
  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => false,
      requireTicket: mock(),
      offer: mock(),
      receive: mock(),
      commit: mock(),
      abort: mock(),
    },
    audit: { record: () => {} },
    now: () => 1_800_000_000_000,
  });

  const response = await handler.respond(
    new Request('http://100.64.0.2:7070/move/commit', { method: 'POST' }),
    '192.168.1.5',
  );

  expect(response.status).toBe(403);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    defined: false,
    code: 'FORBIDDEN',
    status: 403,
    message: 'moves come only over the tailnet',
    error: 'moves come only over the tailnet',
  });
});

test('it audits a refused call with its failure and no imp', () => {
  const record = mock();

  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => true,
      requireTicket: () =>
        Promise.reject(new MoveRequestError('UNAUTHORIZED', 'unknown move ticket')),
      offer: mock(),
      receive: mock(),
      commit: mock(),
      abort: mock(),
    },
    audit: { record },
    now: () => 1_800_000_000_000,
  });

  const responded = handler.respond(
    new Request('http://100.64.0.2:7070/move/abort', { method: 'POST' }),
    '100.64.0.1',
  );

  expect(responded).resolves.toMatchObject({ status: 401 });

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'move.abort',
      actor: { kind: 'tailnet', name: 'move from 100.64.0.1' },
      impName: null,
      startedAt: 1_800_000_000_000,
    },
    new MoveRequestError('UNAUTHORIZED', 'unknown move ticket'),
  );
});

test('it audits a commit with the imp its ticket names', async () => {
  const record = mock();

  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => true,
      requireTicket: () =>
        Promise.resolve({
          row: buildMockMoveTicketRow({ name: 'dev' }),
          ticket: { id: 'ticket-id', secret: 'ticket-secret' },
        }),
      offer: mock(),
      receive: mock(),
      commit: () => Promise.resolve({ isCommitted: true }),
      abort: mock(),
    },
    audit: { record },
    now: () => 1_800_000_000_000,
  });

  const response = await handler.respond(
    new Request('http://100.64.0.2:7070/move/commit', { method: 'POST' }),
    '100.64.0.1',
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ isCommitted: true });

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'move.commit',
      actor: { kind: 'tailnet', name: 'move from 100.64.0.1' },
      impName: 'dev',
      startedAt: 1_800_000_000_000,
    },
    null,
  );
});

test('it answers a stream part it took with 202 and the part', async () => {
  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => true,
      requireTicket: () =>
        Promise.resolve({
          row: buildMockMoveTicketRow({ name: 'dev' }),
          ticket: { id: 'ticket-id', secret: 'ticket-secret' },
        }),
      offer: mock(),
      receive: () => Promise.resolve({ kind: 'part' as const, part: 3 }),
      commit: mock(),
      abort: mock(),
    },
    audit: { record: () => {} },
    now: () => 1_800_000_000_000,
  });

  const response = await handler.respond(
    new Request('http://100.64.0.2:7070/move/receive', { method: 'POST', body: 'frames' }),
    '100.64.0.1',
  );

  expect(response.status).toBe(202);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ part: 3 });
});

test('it answers the finish of a stream with the receipt', async () => {
  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => true,
      requireTicket: () =>
        Promise.resolve({
          row: buildMockMoveTicketRow({ name: 'dev' }),
          ticket: { id: 'ticket-id', secret: 'ticket-secret' },
        }),
      offer: mock(),
      receive: () =>
        Promise.resolve({ kind: 'receipt' as const, receipt: { body: '{}', mac: 'ab' } }),
      commit: mock(),
      abort: mock(),
    },
    audit: { record: () => {} },
    now: () => 1_800_000_000_000,
  });

  const response = await handler.respond(
    new Request('http://100.64.0.2:7070/move/receive', { method: 'POST' }),
    '100.64.0.1',
  );

  expect(response.status).toBe(200);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ body: '{}', mac: 'ab' });
});

test('it answers a stream that fails inside the target with 500 and the failure', async () => {
  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => true,
      requireTicket: () =>
        Promise.resolve({
          row: buildMockMoveTicketRow({ name: 'dev' }),
          ticket: { id: 'ticket-id', secret: 'ticket-secret' },
        }),
      offer: mock(),
      receive: () => Promise.reject(new Error('the disk went away')),
      commit: mock(),
      abort: mock(),
    },
    audit: { record: () => {} },
    now: () => 1_800_000_000_000,
  });

  const response = await handler.respond(
    new Request('http://100.64.0.2:7070/move/receive', { method: 'POST', body: 'frames' }),
    '100.64.0.1',
  );

  expect(response.status).toBe(500);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    defined: false,
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    message: 'the disk went away',
    error: 'the disk went away',
  });
});

test('it answers a route the contract lacks with 404', async () => {
  const handler = createMovePeerHandler({
    calls: {
      isAllowedPeer: () => true,
      requireTicket: mock(),
      offer: mock(),
      receive: mock(),
      commit: mock(),
      abort: mock(),
    },
    audit: { record: () => {} },
    now: () => 1_800_000_000_000,
  });

  const response = await handler.respond(
    new Request('http://100.64.0.2:7070/move/nowhere', { method: 'POST' }),
    '100.64.0.1',
  );

  expect(response.status).toBe(404);

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ error: 'not found' });
});
