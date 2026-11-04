import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDevLock } from './with-dev-lock';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'dev-lock-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory };
}

test('it returns what the run returns', async () => {
  const ctx = await setupTest();
  const ran = await withDevLock(ctx.directory, 'imp-bench', () => Promise.resolve('measured'));

  expect(ran).toBe('measured');
});

test('it refuses a second lock on a dev instance while the first holds it, and names the holder', async () => {
  const ctx = await setupTest();

  const inner = withDevLock(ctx.directory, 'imp-bench', () =>
    withDevLock(ctx.directory, 'imp-bench', () => Promise.resolve('measured')),
  );

  expect(inner).rejects.toThrowWithMessage(
    Error,
    `process ${String(process.pid)} holds the dev instance imp-bench (${join(ctx.directory, 'impz-dev-imp-bench.lock')})`,
  );
});

test('it locks two dev instances of different names at once', async () => {
  const ctx = await setupTest();

  const ran = await withDevLock(ctx.directory, 'imp-bench', () =>
    withDevLock(ctx.directory, 'imp-dev', () => Promise.resolve('measured')),
  );

  expect(ran).toBe('measured');
});
