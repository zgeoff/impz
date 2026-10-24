import { expect, mock, onTestFinished, test } from 'bun:test';
import { SimulatedClock, createActor } from 'xstate';
import { buildUploadMachine } from './build-upload-machine';

function setupTest() {
  const clock = new SimulatedClock();

  const free = mock<() => void>();
  const actor = createActor(buildUploadMachine, { input: { ttlMs: 60_000, free }, clock });

  actor.start();

  onTestFinished(() => {
    actor.stop();
  });

  return { clock, free, actor };
}

test('it frees an upload that no build takes within its time to live', () => {
  const ctx = setupTest();

  ctx.clock.increment(60_000);

  expect(ctx.free).toHaveBeenCalledOnce();
  expect(ctx.actor.getSnapshot().value).toBe('released');
});

test('it holds an upload until its time to live ends', () => {
  const ctx = setupTest();

  ctx.clock.increment(59_999);

  expect(ctx.free).not.toHaveBeenCalled();
  expect(ctx.actor.getSnapshot().value).toBe('held');
});

test('it keeps a taken upload past its time to live', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'take' });
  ctx.clock.increment(120_000);

  expect(ctx.free).not.toHaveBeenCalled();
  expect(ctx.actor.getSnapshot().value).toBe('taken');
});

test('it frees a taken upload once when its build releases it, however often', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'take' });
  ctx.actor.send({ type: 'release' });
  ctx.actor.send({ type: 'release' });

  expect(ctx.free).toHaveBeenCalledOnce();
});

test('it frees a held upload when impd stops', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'stop' });

  expect(ctx.free).toHaveBeenCalledOnce();
  expect(ctx.actor.getSnapshot().value).toBe('released');
});

test('it leaves a taken upload to its build when impd stops', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'take' });
  ctx.actor.send({ type: 'stop' });

  expect(ctx.free).not.toHaveBeenCalled();
  expect(ctx.actor.getSnapshot().value).toBe('taken');
});

test('it ignores a release before a build takes the upload', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'release' });

  expect(ctx.free).not.toHaveBeenCalled();
  expect(ctx.actor.getSnapshot().value).toBe('held');
});
