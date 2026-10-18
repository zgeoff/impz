import { expect, test } from 'bun:test';
import { buildStubHeldAnswer } from './build-stub-held-answer';

test('it settles arrived once a request comes, and holds its answer', async () => {
  const held = buildStubHeldAnswer();
  const answer = held.answer();

  await held.arrived;

  const settled = await Promise.race([answer.then(() => 'answered'), Promise.resolve('held')]);

  expect(settled).toBe('held');
});

test('it answers a held request with the response release gives', async () => {
  const held = buildStubHeldAnswer();
  const answer = held.answer();

  held.release(new Response('from upstream', { status: 201 }));

  const response = await answer;
  const body = await response.text();

  expect(response.status).toBe(201);
  expect(body).toBe('from upstream');
});

test('it gives the released response to a request that comes after the release', async () => {
  const held = buildStubHeldAnswer();

  held.release(new Response('from upstream'));

  const response = await held.answer();
  const body = await response.text();

  expect(body).toBe('from upstream');
});
