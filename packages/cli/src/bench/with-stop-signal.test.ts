import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { withStopSignal } from './with-stop-signal';

function setupTest() {
  // oxlint-disable-next-line unicorn/prefer-event-target -- process, the source the bench listens on, is an EventEmitter
  return { source: new EventEmitter() };
}

test.each([['SIGINT'], ['SIGTERM'], ['SIGHUP']])('it stops the run at %s', async (name) => {
  const ctx = setupTest();

  const isAborted = await withStopSignal(ctx.source, (signal) => {
    ctx.source.emit(name);

    return Promise.resolve(signal.aborted);
  });

  expect(isAborted).toBe(true);
});

test('it leaves the run going while no signal comes', async () => {
  const ctx = setupTest();

  const isAborted = await withStopSignal(ctx.source, (signal) => Promise.resolve(signal.aborted));

  expect(isAborted).toBe(false);
});

test('it stops listening once the run ends', async () => {
  const ctx = setupTest();

  await withStopSignal(ctx.source, () => Promise.resolve());

  expect(ctx.source.eventNames()).toStrictEqual([]);
});

test('it stops listening when the run fails, and passes its failure on', () => {
  const ctx = setupTest();
  const running = withStopSignal(ctx.source, () => Promise.reject(new Error('the bench broke')));

  expect(running).rejects.toThrowWithMessage(Error, 'the bench broke');
  expect(ctx.source.eventNames()).toStrictEqual([]);
});
