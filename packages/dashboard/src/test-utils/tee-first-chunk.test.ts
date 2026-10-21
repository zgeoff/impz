import { expect, test } from 'bun:test';
import { teeFirstChunk } from './tee-first-chunk';

test('it settles with no failure once the first chunk arrives, and leaves the body whole', async () => {
  const teed = teeFirstChunk(
    new Response(
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('first '));
          controller.enqueue(new TextEncoder().encode('second'));
          controller.close();
        },
      }),
      { status: 200 },
    ),
  );

  const failure = await teed.firstChunk;
  const body = await teed.response.text();

  expect(failure).toBeNull();
  expect(body).toBe('first second');
});

test('it keeps the status and headers of the response', () => {
  const teed = teeFirstChunk(
    new Response('ping', { status: 201, headers: { 'content-type': 'text/plain' } }),
  );

  expect(teed.response.status).toBe(201);
  expect(teed.response.headers.get('content-type')).toBe('text/plain');
});

test('it settles with the failure of a stream that errors before its first chunk', () => {
  const teed = teeFirstChunk(
    new Response(
      new ReadableStream({
        start: (controller) => {
          controller.error(new Error('the connection dropped'));
        },
      }),
    ),
  );

  expect(teed.firstChunk).resolves.toStrictEqual(new Error('the connection dropped'));
});

test('it settles with a failure when the stream ends with no chunk', () => {
  const teed = teeFirstChunk(
    new Response(
      new ReadableStream({
        start: (controller) => {
          controller.close();
        },
      }),
    ),
  );

  expect(teed.firstChunk).resolves.toStrictEqual(
    new Error('the stream ended before its first chunk'),
  );
});

test('it settles with a failure for a response with no body', () => {
  const teed = teeFirstChunk(new Response(null, { status: 204 }));

  expect(teed.firstChunk).resolves.toStrictEqual(new Error('the response has no body'));
});
