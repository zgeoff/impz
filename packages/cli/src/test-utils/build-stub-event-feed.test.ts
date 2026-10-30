import { expect, mock, test } from 'bun:test';
import { EVENT_VERSION } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { createImpClient } from '@impz/client';
import { buildStubEventFeed } from './build-stub-event-feed';

test('it opens once and hands each sent event to its watcher', async () => {
  const feed = buildStubEventFeed();

  const stopper = new AbortController();

  const onOpen = mock<(attempt: number) => void>(() => {});
  const onEvent = mock<(event: ImpEvent) => void>(() => {});

  const watching = feed.watchEvents(createImpClient({ url: 'http://localhost:1' }), {
    onOpen,
    onEvent,
    signal: stopper.signal,
  });

  const event: ImpEvent = {
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date('2026-10-01T10:00:00Z'),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: buildMockImp({ name: 'fern' }),
    detail: { durationMs: 42 },
  };

  await feed.send(event);

  stopper.abort();

  await watching;

  expect(onOpen).toHaveBeenCalledExactlyOnceWith(1);
  expect(onEvent).toHaveBeenCalledExactlyOnceWith(event);
});

test('it stays open until its watcher aborts', async () => {
  const feed = buildStubEventFeed();

  const stopper = new AbortController();

  const watching = feed.watchEvents(createImpClient({ url: 'http://localhost:1' }), {
    onEvent: () => {},
    signal: stopper.signal,
  });

  await feed.send({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: EVENT_VERSION,
    at: new Date('2026-10-01T10:00:00Z'),
    ev: 'ImpChanged',
    reason: 'woke',
    imp: buildMockImp({ name: 'fern' }),
  });

  const isPending = Bun.peek.status(watching) === 'pending';

  stopper.abort();

  expect(isPending).toBe(true);
  expect(watching).resolves.toBeUndefined();
});
