import { expect, mock, test } from 'bun:test';
import { makeRacedCallFetch } from './make-raced-call-fetch';

test('it runs the race hook before it sends the first call on the raced path', async () => {
  const calls: string[] = [];

  const send = mock<(request: Request) => Promise<Response>>(() => {
    calls.push('send');

    return Promise.resolve(new Response('{}'));
  });

  const onRace = mock(() => {
    calls.push('race');

    return Promise.resolve();
  });

  const racedFetch = makeRacedCallFetch(send, '/rpc/imps/destroy', onRace);

  await racedFetch(new Request('http://impd.test/rpc/imps/destroy', { method: 'POST' }));

  expect(calls).toStrictEqual(['race', 'send']);
});

test('it sends a later call on the raced path with no race', async () => {
  const send = mock<(request: Request) => Promise<Response>>(() =>
    Promise.resolve(new Response('{}')),
  );

  const onRace = mock(() => Promise.resolve());
  const racedFetch = makeRacedCallFetch(send, '/rpc/imps/destroy', onRace);

  await racedFetch(new Request('http://impd.test/rpc/imps/destroy', { method: 'POST' }));
  await racedFetch(new Request('http://impd.test/rpc/imps/destroy', { method: 'POST' }));

  expect(onRace).toHaveBeenCalledTimes(1);
});

test('it answers a call on any other path as impd does, with no race', async () => {
  const answer = new Response('{"name":"fern"}');

  const send = mock<(request: Request) => Promise<Response>>(() => Promise.resolve(answer));
  const onRace = mock(() => Promise.resolve());

  const response = await makeRacedCallFetch(
    send,
    '/rpc/imps/destroy',
    onRace,
  )(new Request('http://impd.test/rpc/imps/get', { method: 'POST' }));

  expect(response).toBe(answer);
  expect(onRace).not.toHaveBeenCalled();
});
