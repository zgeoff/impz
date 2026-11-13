import { expect, test } from 'bun:test';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import { buildStubClock } from '../../test-utils/platform/build-stub-clock';
import { keepStreamVerified } from './keep-stream-verified';

function setupTest(probes: readonly (boolean | Error)[]) {
  const source = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const state = { isCancelled: false, probed: 0 };
  const clock = buildStubClock();

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      source.resolve(controller);
    },
    cancel: () => {
      state.isCancelled = true;
    },
  });

  const stream = keepStreamVerified(body, {
    probeToken: () => {
      const answer = probes[state.probed] ?? true;

      state.probed += 1;

      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    everyMs: 600_000,
    startTimer: clock.startTimer,
  });

  return { stream, source: source.promise, state, clock };
}

test('#keepStreamVerified passes each chunk on while the token passes', async () => {
  const ctx = setupTest([]);

  const controller = await ctx.source;

  controller.enqueue(new TextEncoder().encode('data: one\n\n'));
  controller.close();

  const text = await new Response(ctx.stream).text();

  expect(text).toBe('data: one\n\n');
});

test('#keepStreamVerified checks the token every interval, and ends the stream and its source once it fails', async () => {
  const ctx = setupTest([true, false]);

  const read = new Response(ctx.stream).text();

  ctx.clock.runFor(600_000);

  await waitFor(() => {
    expect(ctx.clock.readPendingMs()).toStrictEqual([600_000]);
  });

  ctx.clock.runFor(600_000);

  const text = await read;

  expect({ text, probed: ctx.state.probed, isCancelled: ctx.state.isCancelled }).toStrictEqual({
    text: '',
    probed: 2,
    isCancelled: true,
  });
});

test('#keepStreamVerified ends the stream when the check throws', async () => {
  const ctx = setupTest([new Error('the grant check broke')]);

  const read = new Response(ctx.stream).text();

  ctx.clock.runFor(600_000);

  const text = await read;

  expect(text).toBe('');
});

test('#keepStreamVerified stops checking once its reader cancels', async () => {
  const ctx = setupTest([]);

  await ctx.stream.cancel();

  expect({ pending: ctx.clock.readPendingMs(), isCancelled: ctx.state.isCancelled }).toStrictEqual({
    pending: [],
    isCancelled: true,
  });
});
