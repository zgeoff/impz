import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActor } from 'xstate';
import { buildMockSessionOutput } from '../../../../testing/imps/build-mock-session-output';
import { buildStubTapStream } from '../../../../testing/imps/build-stub-tap-stream';
import { createGenerationLog } from './generation-log';
import { sessionLogMachine } from './session-log-machine';
import type { OpeningTap } from './session-log-machine';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'imp-session-log-machine-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const actor = createActor(sessionLogMachine).start();

  onTestFinished(() => {
    actor.stop();
  });

  return { root, actor };
}

test('it gives a key one tap slot, to the first opening', async () => {
  const ctx = await setupTest();

  const first: OpeningTap = { opening: true };
  const second: OpeningTap = { opening: true };

  ctx.actor.send({ type: 'tap.open', key: 'imp-1/a3f1', slot: first });
  ctx.actor.send({ type: 'tap.open', key: 'imp-1/a3f1', slot: second });

  expect(ctx.actor.getSnapshot().context.taps.get('imp-1/a3f1')).toBe(first);
});

test('it frees a tap slot only for the owner that holds it', async () => {
  const ctx = await setupTest();

  const stale: OpeningTap = { opening: true };
  const current: OpeningTap = { opening: true };

  ctx.actor.send({ type: 'tap.open', key: 'imp-1/a3f1', slot: current });
  ctx.actor.send({ type: 'tap.release', key: 'imp-1/a3f1', owner: stale });

  expect(ctx.actor.getSnapshot().context.taps.get('imp-1/a3f1')).toBe(current);
});

test('it never opens a tap again for a log deleted while live', async () => {
  const ctx = await setupTest();

  const log = await createGenerationLog(
    {
      directory: join(ctx.root, 'b'.repeat(32)),
      segmentBytes: 10,
      maxBytes: 20,
      requireRoom: () => Promise.resolve(),
      now: () => 1000,
    },
    {
      session: 'main',
      executionGeneration: 'b'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    },
  );

  const entry = {
    key: `imp-1/${'b'.repeat(32)}`,
    impId: 'imp-1',
    session: 'main',
    generation: 'b'.repeat(32),
    log,
  };

  ctx.actor.send({ type: 'log.add', entry, isStopped: false });
  ctx.actor.send({ type: 'log.remove', key: entry.key });
  ctx.actor.send({ type: 'tap.open', key: entry.key, slot: { opening: true } });

  expect(ctx.actor.getSnapshot().context.taps.has(entry.key)).toBeFalse();
});

test('it leaves the log and tap of a later life alone when an earlier life ends its log', async () => {
  const ctx = await setupTest();

  const options = {
    directory: join(ctx.root, 'c'.repeat(32)),
    segmentBytes: 10,
    maxBytes: 20,
    requireRoom: () => Promise.resolve(),
    now: () => 1000,
  };

  const meta = {
    session: 'main',
    executionGeneration: 'c'.repeat(32),
    bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
  };

  const earlier = {
    key: `imp-1/${'c'.repeat(32)}`,
    impId: 'imp-1',
    session: 'main',
    generation: 'c'.repeat(32),
    log: await createGenerationLog(options, meta),
  };

  ctx.actor.send({ type: 'log.add', entry: earlier, isStopped: false });
  ctx.actor.send({ type: 'imp.forget', impId: 'imp-1' });
  ctx.actor.send({ type: 'imp.admit', impId: 'imp-1' });

  const later = { ...earlier, log: await createGenerationLog(options, meta) };

  onTestFinished(() => {
    later.log.abandon();
  });

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'c'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.actor.send({ type: 'log.add', entry: later, isStopped: false });
  ctx.actor.send({ type: 'tap.open', key: later.key, slot: tap.stream });
  ctx.actor.send({ type: 'log.end', entry: earlier });

  expect(ctx.actor.getSnapshot().context.live.get(later.key)).toBe(later);
  expect(tap.state.closed).toBeFalse();
});

test('it closes the taps of a forgotten imp and counts its life', async () => {
  const ctx = await setupTest();

  const tap = buildStubTapStream(
    buildMockSessionOutput({
      executionGeneration: 'd'.repeat(32),
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      bufferStart: 0,
      end: 0,
      offset: 0,
    }),
  );

  ctx.actor.send({ type: 'tap.open', key: `imp-1/${'d'.repeat(32)}`, slot: tap.stream });
  ctx.actor.send({ type: 'imp.forget', impId: 'imp-1' });

  expect(tap.state.closed).toBeTrue();
  expect(ctx.actor.getSnapshot().context.taps.size).toBe(0);
  expect(ctx.actor.getSnapshot().context.lives.get('imp-1')).toBe(1);
});

test('it tells its owner of a refusal for the cap at most once a minute', async () => {
  const ctx = await setupTest();

  const notices = mock<(impId: string) => void>(() => {});

  ctx.actor.on('cap.notice', (notice) => {
    notices(notice.impId);
  });

  ctx.actor.send({ type: 'cap.refuse', impId: 'imp-1', at: 100_000 });
  ctx.actor.send({ type: 'cap.refuse', impId: 'imp-1', at: 159_999 });
  ctx.actor.send({ type: 'cap.refuse', impId: 'imp-1', at: 160_000 });

  expect(notices.mock.calls).toStrictEqual([['imp-1'], ['imp-1']]);
});
