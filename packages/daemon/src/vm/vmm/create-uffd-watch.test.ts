import { expect, mock, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildImpPaths } from '../storage/data-layout';
import { createUffdWatch } from './create-uffd-watch';
import type { HandlerState } from './uffd-handler';

function setupTest() {
  const stopTimer = mock(() => {});
  const startTimer = mock<(tick: () => void) => () => void>(() => stopTimer);
  const stopPid = mock<(pid: number) => void>(() => {});

  return { startTimer, stopTimer, stopPid };
}

test('it stops a VM on the tick after its page handler dies', () => {
  const ctx = setupTest();
  const paths = buildImpPaths('/data', 'vm');
  const handler: { state: HandlerState } = { state: { state: 'alive', pid: 20 } };

  const watch = createUffdWatch({
    probeVmAlive: () => true,
    readHandlerState: () => handler.state,
    stopPid: ctx.stopPid,
    startTimer: ctx.startTimer,
  });

  watch.watch(10, paths);

  handler.state = { state: 'gone', pid: 20 };

  const tick = ctx.startTimer.mock.calls[0]?.[0];

  invariant(tick);
  tick();

  expect(ctx.stopPid).toHaveBeenCalledExactlyOnceWith(10);
});

test('it stops a VM at once whose page handler is already gone', () => {
  const ctx = setupTest();

  createUffdWatch({
    probeVmAlive: () => true,
    readHandlerState: () => ({ state: 'gone', pid: 20 }),
    stopPid: ctx.stopPid,
    startTimer: ctx.startTimer,
  }).watch(10, buildImpPaths('/data', 'vm'));

  expect(ctx.stopPid).toHaveBeenCalledExactlyOnceWith(10);
});

test('it leaves a VM that has no page handler, and starts no timer', () => {
  const ctx = setupTest();

  createUffdWatch({
    probeVmAlive: () => true,
    readHandlerState: () => ({ state: 'none' }),
    stopPid: ctx.stopPid,
    startTimer: ctx.startTimer,
  }).watch(10, buildImpPaths('/data', 'vm'));

  expect(ctx.stopPid).not.toHaveBeenCalled();
  expect(ctx.startTimer).not.toHaveBeenCalled();
});

test('it keeps a VM whose page handler is alive', () => {
  const ctx = setupTest();

  createUffdWatch({
    probeVmAlive: () => true,
    readHandlerState: () => ({ state: 'alive', pid: 20 }),
    stopPid: ctx.stopPid,
    startTimer: ctx.startTimer,
  }).watch(10, buildImpPaths('/data', 'vm'));

  expect(ctx.stopPid).not.toHaveBeenCalled();
  expect(ctx.stopTimer).not.toHaveBeenCalled();
});

test('it stops its timer once the last watched VM is gone', () => {
  const ctx = setupTest();
  const vm: { alive: boolean } = { alive: true };

  const watch = createUffdWatch({
    probeVmAlive: () => vm.alive,
    readHandlerState: () => ({ state: 'alive', pid: 20 }),
    stopPid: ctx.stopPid,
    startTimer: ctx.startTimer,
  });

  watch.watch(10, buildImpPaths('/data', 'vm'));

  vm.alive = false;

  const tick = ctx.startTimer.mock.calls[0]?.[0];

  invariant(tick);
  tick();

  expect(ctx.stopTimer).toHaveBeenCalledOnce();
  expect(ctx.stopPid).not.toHaveBeenCalled();
});

test('it starts one timer for every VM it watches', () => {
  const ctx = setupTest();

  const watch = createUffdWatch({
    probeVmAlive: () => true,
    readHandlerState: () => ({ state: 'alive', pid: 20 }),
    stopPid: ctx.stopPid,
    startTimer: ctx.startTimer,
  });

  watch.watch(10, buildImpPaths('/data', 'one'));
  watch.watch(11, buildImpPaths('/data', 'two'));

  expect(ctx.startTimer).toHaveBeenCalledOnce();
});
