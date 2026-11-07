import { expect, mock, onTestFinished, test } from 'bun:test';
import { Readable } from 'node:stream';
import { EVENT_VERSION } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { buildMockCheckpoint } from '@impz/api/test-utils/build-mock-checkpoint';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { buildStubAnswerQueue } from '@impz/shared/test-utils/build-stub-answer-queue';
import { ORPCError } from '@orpc/client';
import { UnknownProcedureError } from '../unknown-procedure-error';
import { watchEvents } from './watch-events';
import type { EventSource } from './watch-events';

test('it passes each event of the stream in order, then resolves once impd closes it', async () => {
  const added: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 12,
    logId: 'log-a',
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp: buildMockImp({ name: 'box' }),
  };

  const changed: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 12,
    logId: 'log-a',
    ev: 'ImpChanged',
    reason: 'slept',
    imp: buildMockImp({ name: 'box', state: 'sleeping' }),
  };

  const onEvent = mock<(event: ImpEvent) => void>();

  await watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([added, changed])) } },
    { onEvent },
  );

  expect(onEvent.mock.calls).toStrictEqual([[added], [changed]]);
});

test('it passes only the events of the named imp', async () => {
  const other: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 12,
    logId: 'log-a',
    ev: 'ImpAdded',
    reason: 'created',
    imp: buildMockImp({ name: 'other' }),
  };

  const checkpoint: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 12,
    logId: 'log-a',
    ev: 'CheckpointAdded',
    name: 'box',
    checkpoint: buildMockCheckpoint(),
  };

  const onEvent = mock<(event: ImpEvent) => void>();

  await watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([other, checkpoint])) } },
    { onEvent, name: 'box' },
  );

  expect(onEvent).toHaveBeenCalledExactlyOnceWith(checkpoint);
});

test.each([
  { title: 'every imp', name: undefined },
  { title: 'one imp', name: 'box' },
])('it passes the snapshot and no position to a watch of $title', async (row) => {
  const added: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 12,
    logId: 'log-a',
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp: buildMockImp({ name: 'box' }),
  };

  const position: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 12,
    logId: 'log-a',
    ev: 'Position',
  };

  const onEvent = mock<(event: ImpEvent) => void>();

  await watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([added, position])) } },
    { onEvent, ...(row.name !== undefined && { name: row.name }) },
  );

  expect(onEvent).toHaveBeenCalledExactlyOnceWith(added);
});

test.each([
  { title: 'every imp', name: undefined },
  { title: 'one imp', name: 'box' },
])('it skips an event kind it does not know in a watch of $title', async (row) => {
  const unknown = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 13,
    logId: 'log-a',
    ev: 'KilnFired',
    name: 'box',
  };

  const changed: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 14,
    logId: 'log-a',
    ev: 'ImpChanged',
    reason: 'slept',
    imp: buildMockImp({ name: 'box', state: 'sleeping' }),
  };

  const onEvent = mock<(event: ImpEvent) => void>();

  await watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([unknown, changed])) } },
    { onEvent, ...(row.name !== undefined && { name: row.name }) },
  );

  expect(onEvent).toHaveBeenCalledExactlyOnceWith(changed);
});

test('it passes a reset to a watch of one imp', async () => {
  const reset: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 90,
    logId: 'log-a',
    ev: 'Reset',
  };

  const onEvent = mock<(event: ImpEvent) => void>();

  await watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([reset])) } },
    { onEvent, name: 'box' },
  );

  expect(onEvent).toHaveBeenCalledExactlyOnceWith(reset);
});

test('it rejects with the stream’s failure when it has no reconnect', () => {
  const failure = new TypeError('Unable to connect');

  const watching = watchEvents(
    { events: { stream: () => Promise.reject(failure) } },
    { onEvent: () => {} },
  );

  expect(watching).rejects.toBe(failure);
});

test('it opens a fresh stream after one ends, numbering each open', async () => {
  const controller = new AbortController();

  const onOpen = mock<(attempt: number) => void>();

  const streams = buildStubAnswerQueue([
    () => Promise.resolve(Readable.from([])),
    () => Promise.reject(new TypeError('Unable to connect')),
    () => Promise.resolve(Readable.from([])),
  ]);

  await watchEvents(
    { events: { stream: () => streams.next()() } },
    {
      onEvent: () => {},
      onOpen: (attempt) => {
        onOpen(attempt);

        if (attempt === 3) {
          controller.abort();
        }
      },
      signal: controller.signal,
      reconnect: { delayMs: 1 },
    },
  );

  expect(onOpen.mock.calls).toStrictEqual([[1], [3]]);
  expect(streams.left).toBe(0);
});

test('it opens each later stream after the last event it read', async () => {
  const controller = new AbortController();

  const changed: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 41,
    logId: 'log-a',
    ev: 'ImpChanged',
    reason: 'slept',
    imp: buildMockImp({ name: 'box', state: 'sleeping' }),
  };

  const streams = buildStubAnswerQueue([
    () => Promise.resolve(Readable.from([changed])),
    () => Promise.resolve(Readable.from([])),
  ]);

  const stream = mock<EventSource['events']['stream']>(() => streams.next()());

  await watchEvents(
    { events: { stream } },
    {
      onEvent: () => {},
      onOpen: (attempt) => {
        if (attempt === 2) {
          controller.abort();
        }
      },
      signal: controller.signal,
      reconnect: { delayMs: 1 },
    },
  );

  expect(stream.mock.calls.map((call) => call[0])).toStrictEqual([
    undefined,
    { after: 41, logId: 'log-a' },
  ]);
});

test('it ends with impd’s refusal of the stream, without opening another', () => {
  const refusal = new ORPCError('FORBIDDEN', { status: 403 });

  const stream = mock(() => Promise.reject(refusal));

  const watching = watchEvents(
    { events: { stream } },
    { onEvent: () => {}, reconnect: { delayMs: 1 } },
  );

  expect(watching).rejects.toBe(refusal);
});

test('it ends on an impd that has no event stream, without opening another', async () => {
  const missing = new UnknownProcedureError('events.stream');

  const stream = mock(() => Promise.reject(missing));

  const watching = watchEvents(
    { events: { stream } },
    { onEvent: () => {}, reconnect: { delayMs: 1 } },
  );

  await expect(watching).toReject();

  expect(stream).toHaveBeenCalledOnce();
});

test('it ends with a failure the caller’s retry rule refuses', () => {
  const failure = new TypeError('Unable to connect');

  const watching = watchEvents(
    { events: { stream: () => Promise.reject(failure) } },
    { onEvent: () => {}, reconnect: { delayMs: 1, shouldRetry: () => false } },
  );

  expect(watching).rejects.toBe(failure);
});

test('it ends with what an event callback throws, even with a reconnect', () => {
  const removed: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date(),
    seq: 12,
    logId: 'log-a',
    ev: 'ImpRemoved',
    imp: buildMockImp({ name: 'box' }),
  };

  const failure = new Error('box was destroyed');

  const watching = watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([removed])) } },
    {
      onEvent: () => {
        throw failure;
      },
      reconnect: { delayMs: 1 },
    },
  );

  expect(watching).rejects.toBe(failure);
});

test('it ends with what the open callback throws', () => {
  const failure = new ORPCError('NOT_FOUND', { status: 404 });

  const watching = watchEvents(
    { events: { stream: () => Promise.resolve(Readable.from([])) } },
    {
      onEvent: () => {},
      onOpen: () => Promise.reject(failure),
    },
  );

  expect(watching).rejects.toBe(failure);
});

test('it closes the stream when the open callback throws', async () => {
  const close = mock(() => Promise.resolve({ done: true as const, value: undefined }));

  const stream: AsyncIterable<ImpEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: close,
    }),
  };

  const watching = watchEvents(
    { events: { stream: () => Promise.resolve(stream) } },
    {
      onEvent: () => {},
      onOpen: () => Promise.reject(new Error('the snapshot failed')),
    },
  );

  await Promise.allSettled([watching]);

  expect(close).toHaveBeenCalledTimes(1);
});

test('it ends with what the callback throws when closing the stream fails too', async () => {
  const unhandled = mock<(reason: unknown) => void>();

  process.on('unhandledRejection', unhandled);

  onTestFinished(() => {
    process.off('unhandledRejection', unhandled);
  });

  const failure = new Error('the snapshot failed');

  const stream: AsyncIterable<ImpEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: () => Promise.reject(new Error('the reader was already cancelled')),
    }),
  };

  const watching = watchEvents(
    { events: { stream: () => Promise.resolve(stream) } },
    {
      onEvent: () => {},
      onOpen: () => Promise.reject(failure),
    },
  );

  const [settled] = await Promise.allSettled([watching]);

  // one turn of the event loop, after which an unhandled rejection is reported
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(settled).toStrictEqual({ status: 'rejected', reason: failure });
  expect(unhandled).not.toHaveBeenCalled();
});

test('it resolves once the signal aborts while it waits to reconnect', async () => {
  const controller = new AbortController();

  const watching = watchEvents(
    {
      events: {
        stream: () => {
          controller.abort();

          return Promise.reject(new TypeError('Unable to connect'));
        },
      },
    },
    { onEvent: () => {}, signal: controller.signal, reconnect: { delayMs: 60_000 } },
  );

  await expect(watching).toResolve();
});
