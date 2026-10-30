import { expect, mock, test } from 'bun:test';
import { makeLostAnswerFetch } from './make-lost-answer-fetch';

test('it sends a call on the lost path and throws the error in place of its answer', () => {
  const send = mock<(request: Request) => Promise<Response>>(() =>
    Promise.resolve(new Response('{}')),
  );

  const reset = Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' });

  const request = new Request('http://impd.test/rpc/imps/create', { method: 'POST' });

  const answered = makeLostAnswerFetch(send, '/rpc/imps/create', reset)(request);

  expect(answered).rejects.toBe(reset);
  expect(send).toHaveBeenCalledExactlyOnceWith(request);
});

test('it runs the lost hook after the send and before it throws', async () => {
  const calls: string[] = [];

  const send = mock<(request: Request) => Promise<Response>>(() => {
    calls.push('send');

    return Promise.resolve(new Response('{}'));
  });

  const reset = Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' });

  const onLost = mock(() => {
    calls.push('lost');

    return Promise.resolve();
  });

  const lostFetch = makeLostAnswerFetch(send, '/rpc/imps/destroy', reset, onLost);

  const request = new Request('http://impd.test/rpc/imps/destroy', { method: 'POST' });

  const failure = await lostFetch(request).then(
    () => null,
    (error: unknown) => error,
  );

  expect(calls).toStrictEqual(['send', 'lost']);
  expect(failure).toBe(reset);
});

test('it answers a call on any other path as impd does', async () => {
  const answer = new Response('{"name":"fern"}');

  const send = mock<(request: Request) => Promise<Response>>(() => Promise.resolve(answer));
  const reset = Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' });

  const response = await makeLostAnswerFetch(
    send,
    '/rpc/imps/create',
    reset,
  )(new Request('http://impd.test/rpc/imps/get', { method: 'POST' }));

  expect(response).toBe(answer);
});
