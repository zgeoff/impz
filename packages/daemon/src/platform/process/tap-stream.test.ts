import { expect, mock, test } from 'bun:test';
import { tapStream } from './tap-stream';
import type { StreamEnd } from './tap-stream';

test('it passes every chunk through and ends once as done', async () => {
  const onChunk = mock<(chunk: Uint8Array) => void>();
  const onEnd = mock<(end: StreamEnd) => void>();

  const first = new TextEncoder().encode('a body ');
  const second = new TextEncoder().encode('of bytes');

  const source = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    },
  });

  const text = await new Response(tapStream(source, { onChunk, onEnd })).text();

  expect(text).toBe('a body of bytes');
  expect(onChunk.mock.calls).toStrictEqual([[first], [second]]);
  expect(onEnd).toHaveBeenCalledExactlyOnceWith({ kind: 'done' });
});

test('it ends once as cancel and cancels the source when the reader cancels', async () => {
  const onEnd = mock<(end: StreamEnd) => void>();
  const sourceCancel = mock<(reason: unknown) => void>();

  const source = new ReadableStream<Uint8Array>({ cancel: sourceCancel });

  await tapStream(source, { onEnd }).cancel('client left');

  expect(onEnd).toHaveBeenCalledExactlyOnceWith({ kind: 'cancel' });
  expect(sourceCancel).toHaveBeenCalledExactlyOnceWith('client left');
});

test('it ends once as error with the cause, and errors the stream with no reason, when the source fails', () => {
  const onEnd = mock<(end: StreamEnd) => void>();

  const failure = new Error('the upstream hung up');

  const source = new ReadableStream<Uint8Array>({
    pull: () => Promise.reject(failure),
  });

  const reading = tapStream(source, { onEnd }).getReader().read();

  expect(reading).rejects.toBeUndefined();
  expect(onEnd).toHaveBeenCalledExactlyOnceWith({ kind: 'error', error: failure });
});
