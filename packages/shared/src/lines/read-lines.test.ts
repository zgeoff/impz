import { expect, mock, test } from 'bun:test';
import { readLines } from './read-lines';

test('it reads a line split across chunks, and a last line with no newline', async () => {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(encoder.encode('{"id":1}\n{"i'));
      controller.enqueue(encoder.encode('d":2}\n{"id":3}'));
      controller.close();
    },
  });

  const lines = await Array.fromAsync(readLines(stream));

  expect(lines).toStrictEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
});

test('it decodes a character split across chunks', async () => {
  const bytes = new TextEncoder().encode('café\n');

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes.slice(0, 4));
      controller.enqueue(bytes.slice(4));
      controller.close();
    },
  });

  const lines = await Array.fromAsync(readLines(stream));

  expect(lines).toStrictEqual(['café']);
});

test('it reads no line from an empty stream', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.close();
    },
  });

  const lines = await Array.fromAsync(readLines(stream));

  expect(lines).toStrictEqual([]);
});

test('it cancels the stream when the reader stops before the end', async () => {
  const cancel = mock<(reason: unknown) => void>();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(encoder.encode('{"id":1}\n{"id":2}\n'));
    },
    cancel,
  });

  const lines = readLines(stream);

  await lines.next();
  await lines.return(undefined);

  expect(cancel).toHaveBeenCalledOnce();
});
