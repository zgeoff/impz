import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { startStubCutStream } from './start-stub-cut-stream';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it sends the first line and holds the answer open', async () => {
  const ctx = setupTest();
  const upstream = startStubCutStream(ctx.stack, 'data: first\n\n');

  const response = await fetch(`http://127.0.0.1:${String(upstream.port)}/follow`);

  invariant(response.body);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  // before the server stops, or its reset of the answer goes unhandled
  ctx.stack.defer(() => reader.cancel());

  const first = await reader.read();

  expect(first.value).toBe('data: first\n\n');
});

test('it resets the connection of an open answer on a cut', async () => {
  const ctx = setupTest();
  const upstream = startStubCutStream(ctx.stack, 'data: first\n\n');

  const response = await fetch(`http://127.0.0.1:${String(upstream.port)}/follow`);

  invariant(response.body);

  const reader = response.body.getReader();

  await reader.read();

  upstream.cut();

  expect(reader.read()).rejects.toMatchObject({ code: 'ECONNRESET' });
});

test('it resets the connection of an open answer on a unix socket on a cut', async () => {
  const ctx = setupTest();

  const directory = await mkdtemp(join(tmpdir(), 'cut-stream-'));

  ctx.stack.defer(() => rm(directory, { recursive: true, force: true }));

  const socket = join(directory, 'engine.sock');
  const upstream = startStubCutStream(ctx.stack, 'data: first\n\n', { unix: socket });

  const response = await fetch('http://docker/follow', { unix: socket });

  invariant(response.body);

  const reader = response.body.getReader();

  const first = await reader.read();

  upstream.cut();

  expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
  expect(reader.read()).rejects.toMatchObject({ code: 'ECONNRESET' });
});

test('it holds an answer that starts after a cut', async () => {
  const ctx = setupTest();
  const upstream = startStubCutStream(ctx.stack, 'data: first\n\n');

  const earlier = await fetch(`http://127.0.0.1:${String(upstream.port)}/follow`);

  invariant(earlier.body);

  const earlierReader = earlier.body.getReader();

  await earlierReader.read();

  upstream.cut();

  await Promise.allSettled([earlierReader.read()]);

  const response = await fetch(`http://127.0.0.1:${String(upstream.port)}/follow`);

  invariant(response.body);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  // before the server stops, or its reset of the answer goes unhandled
  ctx.stack.defer(() => reader.cancel());

  const first = await reader.read();

  expect(first.value).toBe('data: first\n\n');
});
