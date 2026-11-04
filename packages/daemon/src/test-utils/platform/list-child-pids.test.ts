import { expect, onTestFinished, test } from 'bun:test';
import { listChildPids } from './list-child-pids';

test('it lists a child that runs', () => {
  const child = Bun.spawn(['sleep', '600']);

  onTestFinished(async () => {
    child.kill();

    await child.exited;
  });

  expect(listChildPids()).toContain(child.pid);
});

test('it drops a killed child once its exit is awaited', async () => {
  const child = Bun.spawn(['sleep', '600']);

  child.kill();

  await child.exited;

  expect(listChildPids()).not.toContain(child.pid);
});
