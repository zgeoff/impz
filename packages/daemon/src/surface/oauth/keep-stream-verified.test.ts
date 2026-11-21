import { expect, test } from 'bun:test';
import { readNextDelayMs } from '@impz/shared/test-utils/read-next-delay-ms';
import { waitFor } from '@zgeoff/testing';
import { createFakeClock } from '@zgeoff/testing/clock';
import { keepStreamVerified } from './keep-stream-verified';

function setupTest(probes: readonly (boolean | Error)[]) {
  const source = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const state = { isCancelled: false, probed: 0 };
  const clock = createFakeClock();

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
    startTimer: clock.schedule,
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

  ctx.clock.advance(600_000);

  await waitFor(() => {
    expect(readNextDelayMs(ctx.clock)).toBe(600_000);
  });

  ctx.clock.advance(600_000);

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

  ctx.clock.advance(600_000);

  const text = await read;

  expect(text).toBe('');
});

test('#keepStreamVerified stops checking once its reader cancels', async () => {
  const ctx = setupTest([]);

  await ctx.stream.cancel();

  expect({ pending: readNextDelayMs(ctx.clock), isCancelled: ctx.state.isCancelled }).toStrictEqual(
    {
      pending: null,
      isCancelled: true,
    },
  );
});

test('#keepStreamVerified stops checking once its source fails', async () => {
  const ctx = setupTest([]);

  const controller = await ctx.source;

  const read = new Response(ctx.stream).text();

  controller.error(new Error('the source failed'));

  const [outcome] = await Promise.allSettled([read]);

  expect({ outcome, pending: readNextDelayMs(ctx.clock) }).toStrictEqual({
    outcome: { status: 'rejected', reason: expect.toBeObject() },
    pending: null,
  });
});
