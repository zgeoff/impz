import { expect, mock, test } from 'bun:test';
import { createStopGuard } from './create-stop-guard.ts';
import { StopError } from './stop-error.ts';
import type { ZfsChild, ZfsIO } from './types.ts';

test('it has no stop code before a signal comes', () => {
  const guard = createStopGuard({ onSignal: () => {} });

  expect(guard.findStopCode()).toBeNull();

  expect(() => {
    guard.throwIfStopped();
  }).not.toThrow();
});

test.each([
  ['SIGTERM', 143],
  ['SIGINT', 130],
] as const)('it stops with the exit code of %s', (signal, exitCode) => {
  const onSignal = mock<ZfsIO['onSignal']>(() => {});
  const guard = createStopGuard({ onSignal });

  onSignal.mock.calls.find((call) => call[0] === signal)?.[1]();
  expect(guard.findStopCode()).toBe(exitCode);

  expect(() => {
    guard.throwIfStopped();
  }).toThrow(new StopError(exitCode));
});

test('it keeps the exit code of the first signal', () => {
  const onSignal = mock<ZfsIO['onSignal']>(() => {});
  const guard = createStopGuard({ onSignal });

  onSignal.mock.calls.find((call) => call[0] === 'SIGINT')?.[1]();
  onSignal.mock.calls.find((call) => call[0] === 'SIGTERM')?.[1]();
  expect(guard.findStopCode()).toBe(130);
});

test('it stops the running child with SIGTERM when a signal comes', async () => {
  const onSignal = mock<ZfsIO['onSignal']>(() => {});
  const guard = createStopGuard({ onSignal });
  const exited = Promise.withResolvers<number>();
  const kill = mock<ZfsChild['kill']>(() => {});
  const running = guard.runChild({ exited: exited.promise, kill, stdout: null, stderr: null });

  onSignal.mock.calls.find((call) => call[0] === 'SIGINT')?.[1]();
  exited.resolve(143);

  const exitCode = await running;

  expect(exitCode).toBe(143);
  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
});

test('it stops a child that starts after the signal came', async () => {
  const onSignal = mock<ZfsIO['onSignal']>(() => {});
  const guard = createStopGuard({ onSignal });
  const kill = mock<ZfsChild['kill']>(() => {});

  onSignal.mock.calls.find((call) => call[0] === 'SIGTERM')?.[1]();

  await guard.runChild({ exited: Promise.resolve(143), kill, stdout: null, stderr: null });

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
});

test('it leaves a child that has exited alone when a later signal comes', async () => {
  const onSignal = mock<ZfsIO['onSignal']>(() => {});
  const guard = createStopGuard({ onSignal });
  const kill = mock<ZfsChild['kill']>(() => {});

  await guard.runChild({ exited: Promise.resolve(0), kill, stdout: null, stderr: null });

  onSignal.mock.calls.find((call) => call[0] === 'SIGTERM')?.[1]();
  expect(kill).not.toHaveBeenCalled();
});
