import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestImpd } from '@impz/daemon/testing';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { waitFor } from '@impz/test-utils/wait-for';
import { $ } from 'bun';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'bench-wake-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  // held still, so impd's wait for a young guest takes no real time
  const impd = await startTestImpd(stack, { frozenClockMs: Date.now() });

  return { directory, impd, scriptPath: join(import.meta.dir, 'bench-wake.sh') };
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
    'impz bench wake-young --concurrency 1 --samples 3 --awake 30s --memory 512m --limit-p50-ms 700 --prefix bench-wake-\n',
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
    'impz bench wake-young --concurrency 1 --samples 3 --awake 0 --memory 1g --limit-p50-ms 500 --prefix bench-wake-\n',
  );
});

test("it runs to the end with a token scoped to bench-wake-*, the pattern in the script's header", async () => {
  const ctx = await setupTest();

  await ctx.impd.createTestImage('base');

  const scoped = await ctx.impd.client.tokens.create({
    name: 'wake-bench',
    scope: 'manage',
    imps: ['bench-wake-*'],
  });

  const result = await $`bash ${ctx.scriptPath} --cycles 3`
    .env({
      ...process.env,
      HOME: ctx.directory,
      XDG_CONFIG_HOME: ctx.directory,
      IMP_URL: ctx.impd.url,
      IMP_TOKEN: scoped.secret,
    })
    .nothrow()
    .quiet();

  const imps = await ctx.impd.client.imps.list();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    stderr: expect.stringMatching(
      /^bench: wake-young at 1: p50 \d+ms, p95 \d+ms, p99 \d+ms over 3 samples, 0 failed\n$/u,
    ),
  });

  expect(imps).toStrictEqual([]);
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

test.each([['SIGINT'], ['SIGTERM']] as const)(
  'it leaves the bench in its place, so %s reaches the bench and its stop handler runs',
  async (signal) => {
    const ctx = await setupTest();

    const impz = createStubBin(
      ctx.directory,
      'impz',
      [
        `trap 'echo stopped >>"$STUB_CALLS"; exit 130' INT TERM`,
        'echo ready >>"$STUB_CALLS"',
        'for _ in $(seq 100); do sleep 0.05; done',
      ].join('\n'),
    );

    const wrapper = Bun.spawn(['bash', ctx.scriptPath], {
      env: { ...process.env, IMP_BIN: join(impz.bin, 'impz') },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    onTestFinished(() => {
      wrapper.kill('SIGKILL');
    });

    await waitFor(() => {
      expect(readFileSync(impz.calls, 'utf8')).toEndWith('ready\n');
    });

    wrapper.kill(signal);

    const exitCode = await wrapper.exited;

    expect(exitCode).toBe(130);
    expect(readFileSync(impz.calls, 'utf8')).toEndWith('ready\nstopped\n');
  },
);

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
