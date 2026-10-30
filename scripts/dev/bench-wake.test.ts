import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'bench-wake-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory, scriptPath: join(import.meta.dir, 'bench-wake.sh') };
}

test('it hands its options to impz bench wake-young at concurrency 1', async () => {
  const ctx = await setupTest();

  const impz = createStubBin(ctx.directory, 'impz');

  const result = await $`bash ${ctx.scriptPath} --cycles 3 --awake 30s --limit-ms 700 --memory 512m`
    .env({ ...process.env, IMP_BIN: join(impz.bin, 'impz') })
    .nothrow()
    .quiet();

  const calls = await readFile(impz.calls, 'utf8');

  expect(result.exitCode).toBe(0);

  expect(calls).toBe(
    'impz bench wake-young --concurrency 1 --samples 3 --awake 30s --memory 512m --limit-p50-ms 700\n',
  );
});

test('it hands impz its defaults when given no options', async () => {
  const ctx = await setupTest();

  const impz = createStubBin(ctx.directory, 'impz');

  await $`bash ${ctx.scriptPath}`
    .env({ ...process.env, IMP_BIN: join(impz.bin, 'impz') })
    .nothrow()
    .quiet();

  const calls = await readFile(impz.calls, 'utf8');

  expect(calls).toBe(
    'impz bench wake-young --concurrency 1 --samples 3 --awake 0 --memory 1g --limit-p50-ms 500\n',
  );
});

test('it exits with the status of the bench', async () => {
  const ctx = await setupTest();

  const impz = createStubBin(ctx.directory, 'impz', 'exit 3');

  const result = await $`bash ${ctx.scriptPath} --cycles 3`
    .env({ ...process.env, IMP_BIN: join(impz.bin, 'impz') })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(3);
});

test('it refuses an option it does not know, and runs no bench', async () => {
  const ctx = await setupTest();

  const impz = createStubBin(ctx.directory, 'impz');

  const result = await $`bash ${ctx.scriptPath} --rounds 3`
    .env({ ...process.env, IMP_BIN: join(impz.bin, 'impz') })
    .nothrow()
    .quiet();

  const calls = await readFile(impz.calls, 'utf8');

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe('bench-wake: unknown option --rounds\n');
  expect(calls).toBe('');
});
