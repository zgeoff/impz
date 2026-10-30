import { expect, mock, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { makeStubEventStream } from './make-stub-event-stream';

test('it opens the stream once, on its first attempt, and sends no event', async () => {
  const onOpen = mock<(attempt: number) => void>(() => {});
  const onEvent = mock(() => {});

  await makeStubEventStream(null)(createImpClient({ url: 'http://localhost:1' }), {
    onOpen,
    onEvent,
  });

  expect(onOpen).toHaveBeenCalledExactlyOnceWith(1);
  expect(onEvent).not.toHaveBeenCalled();
});

test('it fails with the given error after it opened', () => {
  const onOpen = mock<(attempt: number) => void>(() => {});

  const watching = makeStubEventStream(new Error('the stream reset'))(
    createImpClient({ url: 'http://localhost:1' }),
    { onOpen, onEvent: () => {} },
  );

  expect(watching).rejects.toThrowWithMessage(Error, 'the stream reset');
  expect(onOpen).toHaveBeenCalledOnce();
});
